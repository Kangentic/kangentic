# Embedded Browser Pane

A side-pane in the modeless task-detail window (`TaskDetailWindow`) that hosts an Electron `<webview>`, captures the rendered frame plus user annotations + DOM context, and submits it to the active agent as a multi-modal prompt.

## User-facing flow

1. Open a task with an active agent session. Click the **Browser** pill in the dialog header (mutually exclusive with **Changes**).
2. First time in a project: the empty-state prompt asks for a URL. Pick a quick-pick (`localhost:3000`, `5173`, `4321`, `8080`) or type one. Submitting auto-saves it as the project default.
3. URL bar supports back/forward/reload, pin to project default, pin to task override.
4. **Draw** mode (`Ctrl/Cmd+D`): free-draw strokes on a transparent overlay above the webview. Pointer-events flip to `none` on the webview while drawing so events reach the canvas.
5. **Inspect** mode (`Ctrl/Cmd+I`, `Esc` to exit): click an element to capture a structured fingerprint (selector, role, ARIA name, testid, classes, ancestors, computed styles, outerHTML). The picked element keeps a blue persistent overlay that follows scroll/resize until cleared. Re-entering Inspect replaces the prior pick.
6. **Send** (`Ctrl/Cmd+Enter`): composites webview frame + strokes into a single PNG, captures any text selection, builds an XML-tagged prompt, and submits to the agent's PTY via the paste engine.

## Architecture

### Security model

The webview is hardened in `src/main/index.ts`:

- `webviewTag: true` on the host `BrowserWindow`.
- `app.on('web-contents-created', ...)` runs `will-attach-webview` to strip `preload`, force `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`. Non-`http(s):` `src` URLs are rewritten to `about:blank`.
- The same handler attaches per-webview policies after attach:
  - `setWindowOpenHandler` denies all `window.open` and `target=_blank`.
  - `will-navigate` rejects non-`http(s):` schemes.
  - `before-input-event` binds F5 / Ctrl+R / Cmd+R to `webContents.reload`.
- Non-webview contents (the main window, and any pop-out window) get a `setWindowOpenHandler`
  too: always deny the popup, and route an allowed URL (`src/shared/external-url.ts`'s
  `EXTERNAL_OPEN_SCHEMES`) out to the OS default browser instead. This is what stops a
  `window.open()` call - including the one xterm's OSC-8 link fallback used to trigger - from
  spawning a bare, chrome-less `BrowserWindow`.

The webview runs in its own renderer process. The host renderer cannot reach into it; the only channel is `webview.executeJavaScript()` (used by the inspector) and the navigation/capture APIs.

**Cookie isolation:** the webview partition is keyed PER WORKTREE via `browserPartitionForWorktree(worktreePath)` in `src/shared/browser-partition.ts` (returns `persist:kngbrowser-<hash>`). Each task detail runs in its own working directory (a git worktree, or the project root for main-cwd tasks), and that directory is the dev environment. Browser cookies are scoped to HOST not port, so two worktrees running dev servers on `localhost:4200` and `:4300` would clobber each other's `localhost` session under one shared jar - therefore each worktree gets its own persistent jar. Sessions sharing a checkout share the jar (you sign in once per worktree). The renderer (`<webview partition>`, keyed off the session `cwd`) and the main process (the clear-storage handler, which enumerates the project's worktree directories) derive the same name from the same path. The legacy single jar `BROWSER_PARTITION` (`persist:kangentic-browser`) remains for the no-worktree fallback and is also wiped by **Clear browser data**.

### Capture and prompt payload

`src/main/ipc/handlers/browser.ts` (`BROWSER_CAPTURE_SEND`):

1. Validates `sessionId` is a UUID (defense-in-depth against malformed IPC).
2. Writes the composited PNG to `<projectRoot>/.kangentic/sessions/<sessionId>/captures/capture-<timestamp>.png` via `fs.promises.writeFile` (async so libuv flushes before the agent's Read tool opens the file - avoids Windows AV sharing-violation races).
3. Computes the @-mention path with `path.relative(cwd, absolutePngPath)`. Worktree-cwd tasks see `../../sessions/<sid>/captures/foo.png`; project-cwd tasks see the in-tree relative path. Cross-drive on Windows falls back to the absolute path with a console warning.
4. Builds an XML-tagged prompt: top-level `Screenshot: @<path>` for bare-token @-parsers (Claude Code, Gemini CLI), then a `<browser_context>` envelope with `<url>`, optional `<picked_element>` (selector, role, testid, accessibleName, rect, computedStyles, ancestors, outerHTML), and optional `<selected_text>`.
5. Submits via `pasteEngine.pasteAndSubmit` with `bracketed: true, source: 'browser-capture'`.

Captures live under the session directory so they're cleaned up by existing lifecycle: `cleanupTaskSession` (move-to-Backlog, move-to-Done, task-delete) removes the session dir recursively, and `pruneOrphanedDirectories` sweeps stragglers on next project open. No new cleanup hook needed.

### Paste engine

`src/main/pty/paste-engine.ts` is the deterministic paste-and-submit primitive driven by `TerminalSubmit.submitContent`. The full algorithm is documented in the file; key reliability properties:

1. **Chunked atomic write** with `setImmediate` yields between 1KB chunks, sized so Windows ConPTY's child-side ReadFile reliably gets the whole chunk in one read.
2. **Output settle** with a 250ms idle window after first data, capped per-byte, floored at 1000ms for React's commit cycle.
3. **`\r` through the queue** (not `writeRaw`). Routing through `sessionManager.write` matches user keystroke delivery, which empirically lands on Claude Code's TUI; `writeRaw` skips the queue and gets misrouted.
4. **Submission verification** - after `\r`, wait up to 3s for any of three signals racing in parallel: the adapter's `getSubmissionVerifier('paste')` callback resolves `true`, an `activity` event with non-idle state fires, or post-`\r` data bytes cross a 50-byte cursor-blip floor. The signals OR-combine - a verifier resolving `false` does NOT short-circuit the activity / data fallbacks. On timeout, retry `\r` once with a 2s window. Both timeouts → `PasteSubmitError('no-submission-evidence')` → toast.
5. **Bracketed-paste-mode tracking** - if the agent emits `\e[?2004l` (mode off, indicating a permission prompt or modal took focus) during the call, the retry path is skipped to avoid `\r` confirming a destructive action. Surfaced as a different toast: "Agent has a permission prompt or modal open."

Per-adapter verification is exposed via each `AgentAdapter`'s `getSubmissionVerifier(contextType: 'paste' | 'command-injection')` method. `BROWSER_CAPTURE_SEND` calls `TerminalSubmit.submitContent` (paste path) which looks up the session's adapter via `agentRegistry.get(sessionManager.getSessionAgentName(sessionId))` and passes `getSubmissionVerifier('paste')` to `pasteAndSubmit` as the optional `verifier` callback. Slash-command bursts route through `TerminalSubmit.submitKeystrokes` and use `getSubmissionVerifier('command-injection')` for the JSONL polling path. Adapters may return `null` to fall back to the activity/data-byte signals. Engine code itself never branches on agent name.

**Caller contract:** the session must be subscribed to (in `SessionManager.focusedSessionIds`) when the engine is invoked. Both the Browser pane and `TerminalSubmitScheduler` run alongside an active terminal panel that subscribes via `TERMINAL_SUBSCRIBE`, so they satisfy this naturally.

### Capture and Drawing

- `src/renderer/components/browser/captureComposite.ts` - calls `webview.capturePage()` (returns NativeImage; macOS includes alpha, Windows/Linux are RGB), draws onto an offscreen canvas, scales overlay strokes from CSS px to native px, returns base64 PNG.
- `src/renderer/components/browser/useDrawingOverlay.ts` - pointer-events to capture strokes. Captures the stroke array at schedule time to avoid a fast-drag race where `pointerLeave`/`pointerUp` reset the ref between schedule and flush, blanking the visible drawing.
- `src/renderer/components/browser/inspectScript.ts` - element-picker injected via `webview.executeJavaScript`. The picked element gets a persistent blue overlay that tracks scroll/resize (window scroll capture, `ResizeObserver`, viewport resize) until cleared. If the element is removed from the DOM (SPA route, re-render), the overlay is auto-disposed.

### URL persistence

`src/main/browser/browser-url-store.ts`:

- Per-task overrides: `<projectPath>/.kangentic/browser-urls.json`, flat `{ [taskId]: url }` map. Atomic write via tmp + rename.
- Project default: `AppConfig.browser.defaultUrl`, persisted via the existing `ConfigManager.saveProjectOverrides()` (writes `<projectPath>/.kangentic/config.json`).

Both are read and written against an EXPLICIT `projectId` (the task's own, threaded from the pane),
not the ambient current project: a popped-out pane and a retained pane both outlive a project
switch, so resolving ambiently wrote one project's task URL into another project's sidecar.

Resolution rule: `taskOverride > projectDefault > null` (caller renders empty state). Once a URL
has resolved, a later refetch never returns the hook to `loading` and never blanks an
already-showing pane: `BrowserPane` mounts its active subtree only while an effective URL exists,
so either would unmount the `<webview>` and destroy the guest. Auto-save: every successful navigation silently updates the task URL; the first navigation in a project also seeds the project default with a "Saved as project default" toast.

### Agent automation (`kangentic_browser_*`)

Shipped MCP tools let an agent drive THIS pane: screenshot, click, type, keypress, query DOM, read console, wait, navigate, and (opt-in) eval against the dev server the user has loaded. This closes the verify loop without a Kangentic-managed preview.

- **Opening and closing the pane:** an agent opens its OWN task's pane with `kangentic_browser_open_pane` and puts panes away with `kangentic_browser_close_pane`, so hitting `no-pane-open` is no longer a dead end that forces it to stop and ask the user. Pane open state is renderer-owned (`browserOpenTasks`) while the MCP server is main-process, so this crosses the process boundary: `src/main/browser/browser-pane-opener.ts` validates every precondition in main (the open project, the per-project `browser.enabled` gate, the task row, the URL), pushes `BROWSER_PANE_OPEN_REQUEST` / `BROWSER_PANE_CLOSE_REQUEST` fire-and-forget, and then awaits the PANE REGISTRY rather than an acknowledgement. That is deliberate: a reply saying "I set the flag" would not mean the pane is driveable, whereas a registered live guest does. The renderer half is `useBrowserPaneRequestBridge` (mounted by `WindowLayer`'s `BoardBridges`), which opens the pane before requesting the window so the window mounts with the pane already showing rather than changing tree shape one commit later. Opening seeds the task's URL sidecar first, because a pane with no URL renders the empty state and registers no guest at all. See [mcp-server.md](mcp-server.md) for the tools' arguments and scoping.
- **Registration:** the renderer registers each open pane's guest webContents id (`webview.getWebContentsId()`) with the main process on `dom-ready`, via `BROWSER_PANE_REGISTER` / `BROWSER_PANE_UNREGISTER` IPC, and unregisters on unmount. The main-process pane registry (`src/main/browser/browser-pane-registry.ts`) maps the guest to its taskId/sessionId so the tools can target the right pane; main also tracks the guest's own `destroyed` / `did-navigate` so the registry stays honest across a hard reload. The tracked URL is a fallback, not the reported value: `kangentic_browser_list_panes` reads each pane's URL live from the guest, because `did-navigate` never fires for same-document navigation and a dev server's SPA routing, `pushState`, and fragment changes would otherwise leave the cache reporting a URL the pane had left. The cache is used only when the guest is gone or has no URL to report yet.
- **Driving (in-process):** the driver (`src/main/browser/browser-pane-driver.ts`) resolves the target, attaches Chrome DevTools Protocol to the guest webContents, and runs the shared CDP helpers in `src/main/browser/cdp/` (the same content-agnostic driver the dev inspection bridge uses through a compat shim). No HTTP bridge, no lockfile: the pane is in the same process as the MCP server. Debuggers detach synchronously on `before-quit`.
- **Gating:** the global **Agent Browser** settings tab (master enable + per-capability switches: interaction, navigation, eval, restrict-to-localhost) is read live per tool call. `eval` is off by default. See [mcp-server.md](mcp-server.md) and `.claude/rules/browser-automation-driver.md`.

## Cross-platform notes

| Platform | Concern | Status |
|---|---|---|
| Windows | Long paths past MAX_PATH | Handled by Node/libuv internally via `\\?\` prefix |
| Windows | ConPTY per-write latency (1-5ms) | Adds ~500ms-1s of write latency on 100KB+ pastes; not a bug, just a perceived-speed floor |
| Windows | AV scanner sharing violations on capture write | Mitigated by `fs.promises.writeFile` (async flush before agent Read) |
| Windows | Cross-drive `path.relative` returns absolute | Guard added; falls back to absolute path with console warning |
| Windows | WSL-localhost not reachable from Windows host | Empty-state surfaces a hint with `wsl hostname -I` workaround |
| macOS | NativeImage alpha channel | Handled by `ctx.drawImage`; documented for future `getImageData` usage |
| Linux | Super (Meta) key shortcuts | Standard `ctrlKey \|\| metaKey` covers Ctrl on Linux |
| All | Self-signed HTTPS dev server | Webview shows Chromium interstitial; users must accept manually or use HTTP |

## HMR and dev servers

The webview is a regular Chromium browser context. WebSocket, ES modules, fetch all work. HMR through `vite dev` and similar patches in place silently; full reloads trigger `did-navigate` once which clears the picked element (acceptable). No special plumbing needed.

## Settings

- `AppConfig.browser.defaultUrl` (project-overridable) - fallback URL when the task has no override.
- `AppConfig.browser.enabled` (project-overridable) - when `false`, the Browser pill in `TaskDetailHeader` is hidden AND `kangentic_browser_open_pane` refuses with `browser-pane-disabled`. The MCP side is enforced in main rather than left to the UI: `TaskDetailBody` renders the pane on its open flag alone, so a pane opened while this gate is off would show with no pill beside it, and the pill is the user's only way to close it. Default `true`.
- **Clear Browser Data** - destructive action backed by `IPC.BROWSER_CLEAR_STORAGE` (`src/main/ipc/handlers/browser.ts`). Calls `session.fromPartition(BROWSER_PARTITION).clearStorageData(...)` for cookies, localStorage, IndexedDB, shadercache, cachestorage, and serviceworkers, then `clearCache()` and `clearAuthCache()`. Wrapped in a danger-variant `ConfirmDialog` with `showDontAskAgain: false` (a one-shot destructive action should not be suppressible). Per-task URL overrides (`.kangentic/browser-urls.json`) and the project default URL are intentionally left alone. Those are workflow state, not browsing identity. The success toast prompts the user to reload any open browser pane to apply the cleared state, since `clearStorageData` does not refresh in-flight documents.

The Browser tab in `AppSettingsPanel` (per-project, above the separator) exposes all three. Future additions (per-task draw color, capture history) belong here.

- **Agent Browser** (global, below the separator) - a separate tab (`AppConfig.browserAutomation`) gating the `kangentic_browser_*` agent tools: `enabled` (master), `allowInteraction`, `allowNavigation`, `allowEval` (default off), `restrictNavigationToLocalhost` (default off). This is a cross-project security policy, hence global, whereas the per-project Browser tab is pane workflow.

## Limitations and future work

| Item | Status | Tracked |
|---|---|---|
| Per-adapter submission verification (replace heuristic data-byte fallback) | Done | `getSubmissionVerifier(contextType)` declared on every adapter; engine consumes via `PasteOptions.verifier` |
| Clear browser data action in settings | Done | `IPC.BROWSER_CLEAR_STORAGE`; see Settings above |
| Pop-out window for second-monitor workflow | Done | child `BrowserWindow` via the pop-out surface registry; see decision 7 |
| DOM tree picker (vs free-form `getSelection()`) | Future | nice-to-have |
| File downloads from embedded webview | Future | needs `will-download` handler |
| Permission requests (camera, mic, geo) from embedded webview | Future | needs explicit deny via `setPermissionRequestHandler` |
| Devtools exposure on the webview | Future | UX vs. security tradeoff |
| Capture history / thumbnails | Future | feature polish |
| E2E test coverage of Send → paste-engine → submission | Future | test follow-up |

## Test coverage

- **Unit** - `tests/unit/terminal-submit.test.ts` covers the byte-level engine for both `submitContent` (paste) and `submitKeystrokes` (slash-command burst), including settle/cap/floor, verifier + retry, bracketed-paste-mode tracking, abort, timeout, and per-adapter verifier paths. `tests/unit/write-queue.test.ts` (17 cases) covers bracketed-paste-aware chunking. `tests/unit/terminal-submit-scheduler.test.ts` covers task-keyed scheduling: drag-burst coalesce, freshlySpawned waits, cancel/cancelAll. `tests/unit/agent-submission-verifier-shape.test.ts` confirms each adapter implements `getSubmissionVerifier`.
- **UI** - pending. Should cover URL bar, draw/inspect toggles, attachment chips, send disable-on-pending. The mock electron API needs `browser.captureAndSend`, `browser.getUrls`, etc.
- **E2E** - pending. Should cover Send → paste-engine → mock-claude submission round-trip.

## Decision log

Open questions resolved during the build:

1. **Cookie isolation** - per-worktree persistent partitions (`persist:kngbrowser-<hash(worktreePath)>`). Isolates each task's dev environment so concurrent worktrees never share a `localhost` jar, while persisting across restarts. Replaced the original single shared jar when agent automation shipped (the shared jar let an agent read another context's logged-in sessions, and concurrent worktrees clobbered each other's localhost cookies).
2. **Host renderer CSP** - not added in this iteration. The webview is process-isolated, so the absence is not a same-origin escape risk. Defense-in-depth pass deferred.
3. **DevTools exposure** - not enabled. Adds a security surface for the inspect feature; not worth it given Inspect mode covers the common need.
4. **File downloads** - unhandled. A page with `<a download>` will trigger Chromium's default behavior (likely route through `defaultSession` to `Downloads/`). Future hardening: explicit `will-download` deny.
5. **Permissions** - all permission requests (camera, mic, geolocation, notifications, ...) are denied via `setPermissionRequestHandler` on the guest session. Hardened when agent automation shipped, since agent-driven navigation could otherwise reach a page that auto-prompts.
6. **Adapter capability shape** - resolved via `getSubmissionVerifier(contextType)` returning a per-context callback. The callback consumes adapter-specific signals (e.g. Claude's JSONL transcript for command-injection) and returns a boolean.
7. **Pop-out window** - shipped, built as a child `BrowserWindow` exactly as this entry originally proposed, rather than retrofitting re-parenting. A `<webview>` guest's lifetime is bound to its DOM node, so moving the pane between hosts destroys and recreates the guest; the pop-out therefore mounts a fresh `BrowserPane` that re-registers the new `webContentsId` under the same sessionId. `unregisterIfMatches` in `browser-pane-registry.ts` exists solely to stop the outgoing in-app pane's unmount from clobbering that newer registration. See `.claude/rules/pop-out-surface-registry.md`.
8. **Surviving a project switch** - a task-detail window whose Browser pane is open is RETAINED when its project is backgrounded: it stays in the window map, rendering in place but invisible (`opacity: 0`) and inert, so its guest keeps running and the task's agent can keep driving it. It renders from a frozen task row (the board store is project-scoped) and drops its terminal, so the standing cost is one composited zero-opacity webview per pane. Returning to the project ADOPTS the retained window rather than rebuilding it, preserving the guest. Hiding must not use `visibility: hidden` or offscreen positioning: both stop compositing, which hangs `Page.captureScreenshot` and wedges that guest's CDP queue. See `.claude/rules/retained-pane-never-remounts.md`.
9. **Cross-project pane isolation** - the `kangentic_browser_*` tools resolve a target scoped to the caller's own project, taken from the MCP URL path rather than from tool arguments. Before that, an agent in one project could drive another project's pane by omitting `taskId` (the registry default spanned every pane on the machine) or by naming a sessionId it read out of `list_panes`. The pane's registered `projectId` is backfilled in the main process from the session registry, because the renderer's value is ambient `currentProject` and goes stale in a pop-out.

## Files

```
src/main/
  index.ts                                  webview hardening, webviewTag
  ipc/handlers/browser.ts                   BROWSER_CAPTURE_SEND, URL persistence
  pty/paste-engine.ts                       paste-and-submit primitive
  pty/write-queue.ts                        bracketed-paste-aware chunking
  browser/browser-url-store.ts              per-task URL overrides
  browser/browser-pane-registry.ts          open panes by sessionId; caller-scoped target resolution
  browser/browser-pane-opener.ts            open/close a pane for the caller's task (MCP lifecycle tools)
  browser/browser-pane-driver.ts            withGuest: policy gate, resolve, CDP attach, error envelope
  browser/browser-automation-config.ts      resolved Agent Browser policy
  browser/cdp/                              the single shared CDP driver (+ bounded screenshot)

src/renderer/components/browser/
  BrowserPane.tsx                           top-level component (loading/empty/active)
  BrowserEmptyState.tsx                     URL prompt + quick picks + WSL hint
  AttachmentChips.tsx                       chip strip (strokes, picked element)
  captureComposite.ts                       PNG compositor
  useDrawingOverlay.ts                      stroke capture
  useBrowserUrl.ts                          URL resolution hook
  inspectScript.ts                          element-picker + persistent overlay
  webview-types.ts                          structural types for <webview>

src/renderer/window-manager/
  bridge/retained-task-snapshots.ts         frozen task rows a retained window renders from
  bridge/useBrowserPaneRequestBridge.ts     applies main's open/close pane pushes to browserOpenTasks
  components/
  TaskDetailWindow.tsx                      browser/changes mutually exclusive (task detail is now a modeless window)
src/renderer/components/dialogs/
  task-detail/TaskDetailBody.tsx            2-col layout when Browser is on
  task-detail/TaskDetailHeader.tsx          Browser pill

src/shared/
  ipc-channels.ts                           BROWSER_*
  types.ts                                  BrowserCaptureInput, BrowserPickedElement, AppConfig.browser

tests/unit/
  terminal-submit.test.ts
  terminal-submit-scheduler.test.ts
  write-queue.test.ts
```
