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
  - `setWindowOpenHandler` allows an http(s) `window.open` / `target=_blank` into a chromed popup
    window on the guest's own session, and denies every other scheme. See decisions 10 to 12.
  - `setPermissionRequestHandler` AND `setPermissionCheckHandler` both read
    `isEmbeddedBrowserPermissionAllowed` (decision 14).
  - `session.on('will-download')` saves to the OS Downloads folder, installed once per `Session`
    (decision 13).
  - `will-navigate` rejects non-`http(s):` schemes.
  - `before-input-event` binds F5 / Ctrl+R / Cmd+R to `webContents.reload`, EXCEPT while an
    agent is driving the pane. During a drive every keystroke that reaches this handler is the
    user's (CDP input does not fire it), so it is `preventDefault`ed and routed to their
    terminal instead; `encodeTerminalKey` maps no Ctrl chord and no `F5`, so a reload chord is
    swallowed rather than reloading the page or reaching the terminal. The guard spans the
    whole burst including its quiet tail, so a back-to-back agent run holds it continuously.
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
so either would unmount the `<webview>` and destroy the guest. Auto-save: every successful navigation silently updates the task URL. The project default is never set automatically - only by the pane's explicit "Save as project default" action or Settings -> Browser -> Default URL. A task navigation used to seed it on the first navigation in a project, so every sibling task inherited that task's URL on first open - and once parallel tasks each run their own dev server, that inheritance points a sibling at the wrong one.

The pane deliberately does NOT default to a Kangentic-chosen dev-server port. A port the app picked is a number the user never configured, and projects pin their own (often several) in `angular.json`, a vite config, a compose file. So the pane opens on what the user or the agent actually navigated to, and the port ledger stays a question an agent asks (`kangentic_reserve_dev_ports`), never an assignment the pane acts on.

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
| macOS / Linux | Guest mouse back/forward reported as `button: 'back'` | Unverified: every measurement behind decision 25 was Windows. The code fails SAFE where a platform never reports those values - nothing is held, no synthetic release fires, and the renderer subscription is inert - so the gesture is simply absent rather than broken |
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
| File downloads from embedded webview | Done | saved to the OS Downloads folder with a toast; see decision 13 |
| Permission requests (camera, mic, geo) from embedded webview | Done | deny-by-default request AND check handlers on the guest session; see decisions 5 and 14 |
| `window.open` / `target=_blank` popups | Done | chromed popup on the guest's own session; see decisions 10 to 12 |
| Google federated sign-in inside the pane | Won't fix | Google refuses embedded user agents; see decision 15 |
| An agent-opened window stealing the user's keyboard focus | Done | `openedByAgent` stamp + an exclusive arrival-focus tier; see decision 16 |
| Focus moving into the pane while an agent drives it | Accepted, and SHOWN | unavoidable: driving a page means clicking it, and a click focuses the guest. The terminal dims, the pane is marked "Agent typing here", and stray keystrokes are still routed to the terminal. Three attempts to eliminate it were built, measured, and reverted; see decisions 18 and 19 |
| Selector-less `type` / `keypress` | Accepted limitation | only land when the pane already holds focus. Use a selector, or `text` ending in `\n` to submit; see decision 18 |
| Dictation into the pane's note input | Done | a focused text field wins over every terminal tier, and the transcript is written with the native value setter; see decision 21 |
| Dictation in the rest of the app | Done | allow-by-default: any focused text field is a target, so no surface has to opt in; see decision 21 |
| Auto-submit committing a half-written form | Done | release presses Enter only where Enter commits ONE field; a form with two or more text inputs inserts without submitting; see decision 21 |
| Dictation into a text field inside the GUEST PAGE | Done | `<webview>.executeJavaScript` reaches the guest's focused field directly; password fields refuse, and dictation fills but never submits. A cross-origin iframe stays unreachable (top frame only); see decision 24 |
| An intercepted keystroke aimed at the note input | Done | delivered to the field (printable characters and Backspace only, Enter still dropped) instead of being lost; see decision 21 |
| The dictation chip landing on the split seam and covering pane controls | Done | it anchors to the target itself (the field, or the terminal's own pane) rather than to the window, whose centre IS the seam; see decision 22 |
| Scroll primitive, and modifier-click (Ctrl/Shift+click) | Future | `click` scrolls its own target into view, but there is no standalone scroll tool and no way to send a modified click |
| Cross-platform verification of the focus behavior | Unverified | every measurement was Windows; the out-of-process guest focus path is exactly what differs on macOS/Linux. CI's Linux tiers exercise the code paths, not this behavior |
| Google refusal signature (`/signin/oauth/error`) | Unverified | written from documented behavior, never captured from a live `disallowed_useragent` bounce. Benign if wrong (no prompt appears, which is today's behavior); the unit tests pin the matching logic, not the signature |
| Devtools exposure on the webview | Future | UX vs. security tradeoff |
| Capture history / thumbnails | Future | feature polish |
| E2E test coverage of Send → paste-engine → submission | Done on POSIX | `tests/e2e/browser-send-roundtrip.spec.ts`, `test.fixme` on Windows because ConPTY does not echo paste content into scrollback; the wiring is covered at unit tier |

## Driving the browser tools in a `/preview` (zero quota)

The `kangentic_browser_*` family is the one MCP surface that cannot be exercised from an ordinary
MCP client, which makes it easy to assume a preview is missing something. It is not: a preview's
MCP server is at full parity with the dogfooding instance. What the family needs is a CALLER
SESSION, and that requirement is identical in both.

Two facts make the difference, and both bite silently:

1. **`kangentic_browser_open_pane` refuses a connection with no caller session** (`no-caller-task`).
   That is deliberate - the tool takes no `taskId` argument at all, so it can only ever target the
   caller's own task ([[browser-automation-driver]]). Connecting to `/mcp/<projectId>` gets the
   refusal on a preview AND on the dogfooding app; connecting to
   `/mcp/<projectId>/<callerSessionId>` works on both.
2. **A Browser pane needs a live session to exist**, because `sessionId` keys its registry entry,
   its capture directory, and its paste target.

So the rig is: give the task a real PTY session backed by a MOCK CLI (zero quota, see
`tests/fixtures/mock-claude.js`), then talk to the session-scoped MCP URL.

```js
// 1. In the preview's renderer (kangentic_devtools_eval). A raw `command` skips
//    agent resolution entirely, so nothing bills a subscription.
await window.electronAPI.sessions.spawn({
  taskId, projectId,
  command: `node "<repo>/tests/fixtures/mock-claude.js"`,
  cwd: projectPath,
  env: { MOCK_CLAUDE_TUI_REPAINT: '1' },
});
```

```
# 2. URL and token, written per project once it is open:
#    <projectPath>/.kangentic/mcp-config.json
#    For an EPHEMERAL preview that projectPath is NOT the worktree - it is
#    <worktree>/.kangentic/data/preview-projects/project-N.
POST http://127.0.0.1:<port>/mcp/<projectId>/<sessionId>
  X-Kangentic-Token: <token>
  Accept: application/json, text/event-stream
  {"jsonrpc":"2.0","id":1,"method":"tools/call",
   "params":{"name":"kangentic_browser_open_pane","arguments":{"url":"..."}}}
```

Two things that cost real time when forgotten:

- **A preview does not pick up main-process edits without a restart.** `.vite/build/index.js` is
  rebuilt at launch, so a `cdp.ts` change made while a preview runs is simply not in it. Check the
  bundle's mtime against the edit before believing a result, or a fixed bug will look unfixed.
- **A focus measurement against an unfocused preview window is VOID, not a pass.**
  `document.hasFocus()` false means Chromium has no embedder focus to move, so a focus steal cannot
  reproduce and the fix appears to work when nothing was tested. Assert `hasFocus === true` as a
  precondition of every trial.

## Test coverage

- **Unit** - `tests/unit/terminal-submit.test.ts` covers the byte-level engine for both `submitContent` (paste) and `submitKeystrokes` (slash-command burst), including settle/cap/floor, verifier + retry, bracketed-paste-mode tracking, abort, timeout, and per-adapter verifier paths. `tests/unit/write-queue.test.ts` (17 cases) covers bracketed-paste-aware chunking. `tests/unit/terminal-submit-scheduler.test.ts` covers task-keyed scheduling: drag-burst coalesce, freshlySpawned waits, cancel/cancelAll. `tests/unit/agent-submission-verifier-shape.test.ts` confirms each adapter implements `getSubmissionVerifier`.
- **Unit (browser policy)** - `window-open-policy.test.ts` (both handlers: the app window's deny-and-route-out, and the pane's popup allow plus `hardenWebviewPopupWindow`), `embedded-signin-refusal.test.ts`, `webview-download-policy.test.ts`, `browser-partition.test.ts`, `browser-pane-driver.test.ts`, `browser-pane-registry.test.ts`, `browser-pane-opener.test.ts`, `browser-automation-config.test.ts`, `browser-automation-invariants.test.ts`.
- **Unit (input and focus)** - `browser-input-focus-emulation.test.ts` drives the REAL `cdp.ts` through a spying fake debugger and pins the mouse/key payloads, the scroll-into-view ordering, and the focus-emulation lifecycle; `agent-input-focus-guard.test.ts` pins the guard's three pure decisions, including that a text target arms even inside the pane while a non-text element there still does not; `terminal-arrival-focus.test.ts` pins the `agent-window` tier; `window-store-agent-open.test.ts` pins the `openedByAgent` stamp; `agent-input-burst.test.ts` pins the burst debounce behind decision 20 (one begin for a run of back-to-back calls, the end waiting for the quiet window, and `isAgentDriving` covering the tail).
- **Unit (chip placement, decision 22)** - `dictation-anchor.test.ts` pins the placement arithmetic against rects measured from a REAL split window, so its cases are the actual failure rather than an invented one: the chip stays inside its own pane, centres on the pane, rests above the agent's input box for the whole utterance, clears the five rows that box occupies, survives a pane shorter than the reserve, moves only when the PANE does, and flips above at the exact boundary. The DOM half - that `resolveDictationAnchor` finds the right elements at all, and that the chip does NOT move when the xterm caret does - is covered by three cases in `dictation-note-input.spec.ts`.
- **Unit (text targets, decision 21)** - `text-target.test.ts` pins eligibility (allow-by-default: enabled, text-shaped, never `password`, never xterm's helper textarea, and an explicit `data-no-text-target` opt-out), that a revised transcript replaces its anchored span rather than appending, and that the byte decoder drops Enter, Tab, Escape, and the CSI sequences. `dictation-target.test.ts` pins that a focused text input outranks even a visible, focused Command Terminal, and that an excluded one falls through unchanged.
- **UI** - `browser-empty-state`, `browser-pane-active`, `browser-pane-refetch-guard`, `browser-pane-registration` (the guest-identity spec), `browser-pane-request-bridge`, `browser-pane-shortcuts`, `browser-pill-gate`, `browser-settings`, plus `agent-open-pane-focus` and `browser-pane-agent-input-focus` for the focus work, and `dictation-note-input` for decision 21 (the only spec in the tree that needs a microphone, so it launches its own browser with Chromium's fake media device; no assertion depends on the audio content).
- **E2E** - `browser-send-roundtrip.spec.ts`, `browser-ctrl-enter-pty.spec.ts`, `browser-evidence-retry.spec.ts`, `browser-popup-window.spec.ts` (the only tier with a real guest, so the only place the popup's origin title and shared `Session` can be checked at all).
- **Not mechanically testable, and deliberately left to the live rig above:** whether Chromium's real
  focus propagation is suppressed (no tier has a live `<webview>` guest), whether the popup genuinely
  shares the opener's browsing context group, and whether Google's refusal URL still matches.

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
10. **Popups allowed** - `window.open` and `target=_blank` from the pane used to hit a blanket deny handler, so any site whose sign-in is a popup presented as a dead button with nothing in the UI to explain it. The pane now carries `allowpopups` (Electron otherwise disables `window.open` inside the guest before the main process ever sees the request) and the guest's `setWindowOpenHandler` is `createWebviewWindowOpenHandler` (`src/main/window-open-policy.ts`), which allows http(s) and denies everything else with the same `[WINDOW_OPEN]` warn the external handler uses. It denies `mailto:` where the app window's handler allows it: guest pages are agent-navigable and `shell.openExternal` is ShellExecute on Windows, and the guest's `will-navigate` already blocks non-http(s), so this is parity rather than a new restriction. `allowpopups` is unconditional on purpose and is not the trust boundary - a renderer attribute cannot be trusted to be honest, the main-process handler is what enforces policy, and gating the attribute behind a setting would only recreate the dead-button symptom behind a switch nobody would find. It must also reach the DOM as a STRING: React types the attribute boolean, `allowpopups` is absent from react-dom's attribute table, and a boolean is dropped with a console warning, which would leave the whole policy unreachable behind a passing typecheck.
11. **Popup chrome and hardening** - the popup is a real OS window with `frame: true` and its title forced to the target's host (`accounts.google.com`, or `Not secure - <host>` for http), because the OS title bar is the only origin indicator the window has and a page free to name itself would be a phishing surface: `page-title-updated` is `preventDefault()`ed and the title re-asserted on `did-navigate` and `did-navigate-in-page`, while the constructor title is seeded from the requested URL so the window is labelled before its first byte loads. There is deliberately no synchronous title call at hardening time, because `getURL()` is still empty there and would clobber that seeded title. Its `webPreferences` repeat the guest's hardening exactly (no preload, `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`) plus `webviewTag: false`, since a child window inherits none of the opener's preferences on Electron 30 and later. Custom HTML chrome was rejected as a second renderer surface to build and test for a window that is open for fifteen seconds, and `WindowOpenHandlerResponse.createWindow` was rejected too even though it would remove an ordering dependency: it needs a literal `new BrowserWindow(` in a third file and would break the two-site rule in `.claude/rules/pop-out-surface-registry.md`. The popup is instead described declaratively through `overrideBrowserWindowOptions` and hardened in `did-create-window`, which fires after `web-contents-created` has already given the popup the external handler and therefore wins by running last. The popup is deliberately not registered in `browserPaneRegistry` and so is invisible to the `kangentic_browser_*` tools: an agent should not be able to drive a live sign-in window. Live-verified: `window.open` from a guest produces an OS window titled `example.com` rather than the page's own title.
12. **Popup cookie jar** - `overrideBrowserWindowOptions.webPreferences.session` is set to the guest's own `Session` OBJECT rather than to a partition string, which Electron documents as taking precedence and which puts the popup in the exact per-worktree jar the pane uses without the main process re-deriving the partition name. This is not only about cookies: a popup in a different storage partition is in a different browsing context group, which severs `window.opener` and the `postMessage` channel almost every OAuth flow uses to hand its result back, and breaks the `popup.closed` poll that tells the opener the user gave up. All three were verified live against a real guest: a cookie set in the guest was readable from the popup, `popup.opener === window` held, and `window.close()` from the opener tore the popup down. A popup may itself open one more popup under the identical policy, so a chained identity-provider hop stays in the same jar instead of being ejected to the system browser; popups are capped at four per pane as a runaway guard, counted at GRANT rather than at creation because `did-create-window` fires after the handler has already answered and a burst of `window.open` calls would otherwise clear a materialized-count check every time.
13. **File downloads** - allowed, and saved without a prompt to the OS Downloads folder (`app.getPath('downloads')`, with a ` (n)` suffix inserted before the extension when the name is taken), which is what Chrome does by default. This replaces the original "unhandled, future hardening: explicit deny" position, which on inspection bought nothing: the agent driving the pane already has full filesystem write through its own tools, so a deny would only have broken the human's use of the pane, and leaving the event unhandled raises a native save dialog that can block an agent-driven pane. The handler is installed at most once per `Session` behind a `WeakSet` guard, because panes sharing a worktree share a partition and `session.on` accumulates listeners where `setPermissionRequestHandler` merely overwrites. The host window is resolved from the download's INITIATING webContents rather than from an install-time closure, since the one install serves every pane on that Session and a captured host goes stale as soon as the first pane closes. Progress is surfaced on the host window's taskbar via `setProgressBar`, and a toast naming the file (with "Show in folder", reusing the existing `shell:showItemInFolder` channel) is pushed on `BROWSER_DOWNLOAD_DONE`.
14. **Permissions on the popup** - the popup shares the guest's `Session`, so the deny policy from decision 5 already covers it and no second handler exists or is needed. What this pass did close is that the guest session had a permission REQUEST handler and no permission CHECK handler, so synchronous checks fell through to Electron's default instead of the pane's policy. Both handlers now read one predicate, `isEmbeddedBrowserPermissionAllowed` in `src/main/permission-policy.ts`, mirroring how the first-party session already keeps its two in lockstep. The predicate grants exactly one permission, `clipboard-sanitized-write`: it is gesture-gated, cannot read the clipboard, is what a real browser allows without prompting, and is listed only because adding a blanket-deny check handler would otherwise newly break `navigator.clipboard.writeText` in the user's own dev server, which would be a regression dressed as hardening. Camera, microphone, geolocation, notifications, MIDI, serial, HID, and USB all stay denied.
15. **Google federated sign-in stays blocked** - Google returns `Error 403: disallowed_useragent` for OAuth in any embedded user agent, and a top-level Electron `BrowserWindow` is still an embedded user agent by that definition, so the popup work does not make "Log in with Google" complete inside the pane and was never expected to. What it changes is the failure mode: a dead button becomes a chromed window showing Google's own error, and every provider that does not enforce the rule works. Spoofing the user agent to strip the `Electron/` token was considered and rejected: it is a deliberate anti-phishing control on Google's side rather than a bug, `<webview useragent>` would misrepresent the app to every site the pane visits and not just to Google, and the token list is a moving target we would maintain forever. When the popup lands on Google's OAuth error path the main process raises a `dialog.showMessageBox` parented to that popup offering "Open in my browser", and the copy is honest about its own limit: signing in there signs the user into their real browser and leaves the pane logged out, so the pane's own answer is a non-Google sign-in method on that site. The detector matches a provider OAuth ERROR URL, not the user-agent refusal specifically (that string is in the rendered page, not the URL), and the prompt wording is hedged to match.
16. **An agent never moves the user's keyboard focus** - measured on Electron 41 with a terminal focused in an OS-focused window, one `Input.dispatchMouseEvent` moved `document.activeElement` to the `<webview>` and flipped `document.hasFocus()` to false, so the rest of what the user was typing went into the page. Separately, `kangentic_browser_open_pane` opened a task-detail window whose arriving terminal then legitimately won `resolveArrivalFocus`'s tier 2. Both are closed, and the shape is recorded in `.claude/rules/agent-driven-focus.md`: `withGuest` arms `Emulation.setFocusEmulationEnabled` and announces each drive over `BROWSER_AGENT_INPUT`, the pane restores the user's element only AFTER the drive ends, and an agent-opened window is stamped `openedByAgent` so a new exclusive tier denies arrival focus to every terminal. Restoring DURING a drive was the original design and was reversed on measurement: it breaks the running tool, because once focus leaves the guest its own focused element loses it too and the `type` tool's characters land nowhere. Focus emulation makes the page BEHAVE focused so a blur-sensitive page still works under automation, but it is not what makes a keystroke land - see decisions 18 and 19 for what the pane actually does about the focus move.
17. **The user can keep typing while an agent drives** - restoring focus after the drive still left a window (tens to hundreds of milliseconds) in which the guest genuinely holds focus, so a user mid-sentence would watch their text flow out of the terminal and into a web form. The two input paths turn out to be separable at the guest, which is what makes this fixable rather than a documented limitation: CDP `Input.dispatchKeyEvent` does NOT fire `before-input-event`, while real user input does (main-side instrumentation with a positive control recorded ZERO events across a 120-round drive of ~3400 dispatched keys, while the user's own `Shift` and `Control` presses came through the same handler; an earlier `Ctrl+r` A/B suggested the same conclusion but is unreliable evidence, having run while the guest held no real focus). So any `before-input-event` arriving while a drive is in flight is provably the user's: main `preventDefault()`s it before the page can see it, encodes it as terminal bytes (`src/shared/terminal-key-encoding.ts`, which returns null and DROPS anything it has no safe mapping for), and pushes it to the pane, which writes it to the terminal the user was typing in. Verified end to end on a live guest: characters typed into a driven pane left the page value empty while appearing on the terminal's prompt, an Enter executed the command, and the same keystrokes with no drive in flight typed into the page normally.
18. **Selector-less `type` / `keypress` are a known limitation, not a bug to fix with focus management** - Chromium routes keyboard input only to a focused widget, while mouse input is hit-tested and needs none. So a selector-bearing call works (its synthesized mousedown focuses the guest as a direct side effect of the same input pipeline, and the characters follow inside the SAME call), while a selector-less one only lands when the pane already holds focus. Measured over one 25-second run against a live guest: `kangentic_browser_keypress` returned `ok: true` 278 times and delivered ONE DOM keydown. Two things that look like fixes and are not: `webContents.focus()` cannot focus a guest at all (Electron early-returns for one to avoid a fatal NOTREACHED in `WebContentsViewChildFrame`, `electron_api_web_contents.cc`), and `Emulation.setFocusEmulationEnabled` does not affect input ROUTING (`document.hasFocus()` inside the guest was already `true` while keys were being dropped). An implementation that DID acquire guest focus for interact drives was built and measured, and is the reason this is now a documented limitation: holding focus across calls put the agent's own text into the user's terminal at 28, then 95, then 207 characters as mitigations were added, because a `<webview>` is an out-of-process iframe whose focus acquisition is asynchronous and never atomic - anything dispatched before it lands goes to whichever widget still holds focus. Workaround for the common flow: `kangentic_browser_type` maps `\n` to Enter, so `{selector, text: "query\n"}` searches and submits in one call. See `.claude/rules/agent-driven-focus.md`.
19. **An agent drive is shown, not hidden** - the accepted answer to "the agent moved my keyboard focus". Interacting with a page means clicking it, and a click gives the guest real keyboard focus, so the move cannot be designed away; three attempts to make it invisible and safe were built and measured, and each put keystrokes on the wrong side. Instead, while a drive is open the terminal side of the split dims (opacity only - it stays mounted, live, and one click away), the Browser pane takes an accent border, and its toolbar reads "Agent typing here". State lives in `src/renderer/stores/agent-drive-store.ts`, keyed by sessionId, with `BrowserPane` translating from the guest id the signal carries. The keystroke interception stays underneath as the safety net, so a user who types anyway lands in their terminal rather than in a web form. The residual, accepted deliberately: focus does move to the pane during a drive, and the user is told so rather than surprised by it.
20. **The pane hears about a BURST, not each tool call** - `endAgentInput` debounces its end-of-drive announcement, and a call arriving inside the quiet window cancels it. Announcing every call made the pane hand the user's focus back between each consecutive pair: measured at 810 trusted `focusin` events on the terminal during a single drive, against 11 with the debounce. The residual, accepted deliberately: focus still moves to the pane once per burst, as the unavoidable consequence of clicking a page, and returns when the agent stops.
21. **Text can reach the pane's note input without a keyboard** - the note input ("What should the agent do with this?") is where you describe what the agent should do with a capture, and it was the one place in that workflow a keyboard was mandatory: dictation could only ever resolve a TERMINAL, and a keystroke intercepted mid-drive was DROPPED unless the user had been in one. Both are the same missing mechanism - getting text into a React-controlled input - and `src/renderer/utils/text-target.ts` is now it. Two properties are load-bearing. It is ALLOW-BY-DEFAULT: any focused text field is a target, anywhere in the app - a new-task title, a search box, a rename field. It shipped first as an opt-in marker per field, which is safer to reason about and wrong in practice, because every new field silently did nothing until someone remembered to mark it and there is no version of "dictation works here but not there" a user can predict. The exclusions are therefore structural rather than a list to maintain: a `type` that does not hold prose (`password` above all), disabled, read-only, and an explicit `data-no-text-target` opt-out honoured on the field or any ancestor. **The exclusion that matters most is xterm's `.xterm-helper-textarea`**, which is a real `<textarea>` and so matches an allow-by-default rule - it must not, because a terminal already has a delivery path (PTY bytes) and a DOM write would land the transcript in a hidden node xterm clears on the next keystroke, so the words vanish and the shell never sees them. That is a silent, total break of the one path that already worked, and it is denied by class rather than by marker because it is xterm's element and we do not render it. And it writes through the prototype's native `value` setter plus a dispatched `input` event, because assigning `.value` directly updates React's own value tracker too, so React sees no change, never fires `onChange`, and the next render reverts the write - correct-looking for exactly one frame. Dictation resolves such a field as a tier ABOVE every window tier (DOM focus in a field is the most direct statement of intent there is; the window tiers are proxies for it), and release honors the existing auto-submit setting by pressing Enter on the field, which is already what the note input maps to Send. **Auto-submit is scoped by the field's surroundings, not by the field.** Enter in a standalone box does the one thing the user expects; in a multi-field form it commits EVERY field, so dictating a title into the New Task dialog would create the task the instant the user let go of the key with the rest of the form still empty. `mayAutoSubmit` therefore refuses when the field's enclosing `<form>` holds more than one text input - a `<form>` being precisely the declaration that its fields commit together, which makes the rule structural rather than a list of dialogs to maintain (the Browser pane's URL bar is a form with ONE input, so it still submits). Refusing only downgrades release to insert-and-leave; the words still land. The chip reads the resolved decision (`willSubmit`) rather than the raw setting, so its "Release to send" hint never promises a commit the sink will refuse. Closing the note-input case also required `shouldArmFocusGuard` to stop treating "focus was inside the pane" as "not a steal" for text targets specifically: the note input lives inside the pane, so the guard had never armed for it at all. **Dictating into a field inside the GUEST PAGE was ruled a different mechanism and left unsupported here** - it looked to need an async `Runtime.evaluate` round trip per press just to learn which element the guest has focused, a new non-agent CDP path (every path today goes through `withGuest`, which would flash "Agent typing here" and arm the focus guard on the user's own dictation), erase-and-retype partials firing the page's own input handlers on every revision, and an active refusal for `type="password"` - which the renderer-side case never has to make, because it cannot reach one. That estimate was wrong on the mechanism and is superseded by decision 24, which ships it.

22. **A push-to-talk guard is scoped to the PTY it protects, and is never silent** - an auto-submit paste writes bracketed content into a terminal, and fresh bytes arriving mid-paste would split it, so dictation refuses a press aimed at a terminal whose paste is still landing. That guard shipped as one global boolean checked before the target was even resolved, which made it wrong in both directions. Wrong in SCOPE: a paste into a terminal also refused a different terminal, the pane's note input, any app field, and a guest page - none of which can write to a PTY at all, so the common flow of dictating into the agent and then clicking over to the Browser pane simply did nothing. Wrong in VOICE: it said nothing, and the window is not brief. `terminal-submit.ts` deliberately waits for the TUI to settle instead of sleeping a fixed amount ("fast when the machine is fast, patient when it is not"), so it stretches under load - captured live at 2.1 seconds, with two consecutive presses logging `startDictation {active:false, submitting:true}` and doing nothing at all. Silent, global, and seconds long is indistinguishable from a broken button, and was reported as one ("works sometimes, seems to need a reset"). It is now a SET of session ids, checked after the target resolves, and a refused press raises a `busy` chip that names the reason and clears itself. The general form: a guard should name the resource it is protecting, not a global condition, and a refusal the user can trigger by hand needs to be visible.

23. **The dictation chip anchors to the target, not to the window** - it used to anchor to the focused WINDOW and centre horizontally, which is the worst possible rule for a split task-detail window: measured on a real one, frame 538..2022 with the terminal pane at 539..1280 and the Browser pane at 1281..2021, so the window's centre (1280) IS the split seam. The chip straddled the divider whichever side was being dictated into, and its bottom edge landed on the Browser pane's own Clear / Inspect controls. It now anchors to the thing the words are landing in. A text input is exact (it is a DOM node). **A terminal anchors to its PANE, and specifically NOT to its caret.** The caret was tried first and looked like the elegant answer, because xterm appears to compute it for us: it keeps `.xterm-helper-textarea` positioned ON the cursor so an IME composes in the right place, sized to one cell - measured on a live WebGL terminal at `left: 588px; top: 17px`, 7x17. That behaviour is real and still not a usable anchor, because it holds only while the cursor is SHOWN. An agent TUI hides it (`[?25l`), and with it hidden xterm PARKS the textarea somewhere unrelated - measured at `left: 721px; top: 799px` in a 741x829 pane while the caret was on line 2 - then snaps it onto the real caret the instant input arrives. So the chip appeared near the pane's bottom, then slid 468px up the screen the moment the user started speaking, on every single utterance. The pane's bottom BAND is stable, is always inside the right pane, depends on nothing internal to xterm, and lands where the caret would have been anyway, since a TUI keeps its input box at the bottom. How wide that band is was measured rather than guessed: on a live Claude TUI the bottom FIVE rows are the input region (a rule, the prompt line, a rule, a blank, and the status line), so `TERMINAL_INPUT_RESERVE_PX` clears 85px and the chip sits above the words being dictated instead of on them - it covered under three rows before that was checked. It stays a pixel constant rather than rows times a measured cell height, because the only element that reports the cell size is the helper textarea this anchor exists to stop depending on, and it is an approximation either way: the box grows with a multi-line draft, so no fixed number clears every state. The general lesson is worth more than the fix: an internal element positioned for someone ELSE's purpose tracks what that purpose needs, not what you want, and it stops tracking exactly when their need lapses. Placement prefers below and flips above when there is no room, which is the common case rather than the exception - a terminal's anchor IS its pane's bottom edge, and the note field is the last row of its own pane. Horizontal clamping is to the PANE (`data-anchor-bounds`, declared on the Browser pane), because clamping an input to its own FIELD was tried and is wrong: a field narrower than the chip leaves it overhanging, and a field near a pane edge then spills into the neighbour, which is the bug being removed. Two registries already existed and neither could answer "where is this session drawn" - `terminal-mount-registry` holds a refcount, `terminal-grid-registry` is `__KANGENTIC_DEV__`-gated and compiles away - hence a third, tiny `terminal-anchor-registry`.

24. **Guest-page fields ARE reachable, and the first estimate that said otherwise was wrong** - this shipped as a documented non-goal on the reasoning that it needed an async `Runtime.evaluate` per press and a new non-agent CDP path, because every CDP path goes through `withGuest` and would flash "Agent typing here" on the user's own dictation. All of that was mistaken. `<webview>.executeJavaScript` runs a string in the guest straight from the renderer, measured at 1ms to read the focused element and 2ms to write into it, and it touches neither the CDP driver, `withGuest`, nor the agent-input signal - `BrowserPane` already uses the same call for Inspect. `guest-text-target.ts` owns the three injected scripts, and they are deliberately tiny: read some facts, or write one exact string. Every DECISION - eligibility, auto-submit, what the value becomes - stays host-side, so no rule has a second copy living in a template literal where no test can reach it. Password fields refuse (the probe reports `reason: 'password'` and the chip says so, anchored to the field rather than a far corner). **Dictation never SUBMITS in a guest - it only fills.** An earlier version ran the host's multi-field rule against the guest's own form, which was strictly worse than not trying: that rule is our inference about a page we do not control, and a single-field form is not automatically safe (a "type DELETE to confirm" box is one field). Filling the field and letting the person press Enter costs one keystroke and deletes a whole class of wrong guesses, along with the submit script, the form-field count, and the branch that consumed them. **Permanent limitation:** `executeJavaScript` runs in the guest's TOP frame only, so a field inside a cross-origin iframe is unreachable.
25. **A guest consumes the mouse outright, so main forwards the back/forward buttons** - dictation and back-navigation both live on `Mouse:Back`, and both were simply dead whenever the page had focus. Measured with a real mouse against a live guest: one back-button press produced 31 events inside the page and **ZERO** on the host window, so no renderer listener could ever see it. Three candidate fixes were considered and two were wrong on the evidence: `BrowserWindow`'s `app-command` never fired at all (the `WM_APPCOMMAND`-goes-to-the-window reasoning did not hold), and Electron's own docs list only `left`/`middle`/`right` for `MouseInputEvent.button`, which nearly ruled out the option that works. `webContents.on('input-event')` on the guest DOES report `button: 'back'`, with a real mouseDown/mouseUp PAIR (measured: a 1534ms hold) - which is what makes push-to-HOLD possible rather than a one-shot toggle. Main forwards those over `BROWSER_GUEST_MOUSE_BUTTON` with a MAIN-side timestamp, because the renderer's own clock is congested by the work a press starts (mic permission, engine start, AudioWorklet load: an 80ms timer measured 414ms), which would misfile a tap as a hold. `mouseLeave` synthesises a release: a real press whose pointer left the webview reported its DOWN and never an UP, which would otherwise strand dictation recording with the microphone open. The forward is gated on the user's actual binding, so rebinding push-to-talk to a key stops the button dictating. `input-event` is observational with no `preventDefault`, so the page still sees the button - acceptable because Chromium does not navigate a `<webview>` on it, which is why the navigation had to be built by hand in the first place.
21. **Concurrent drivers are serialized per GUEST, not per pane or per caller** - three `general-purpose` subagents drove one pane at once, interleaving navigations, clicks and screenshots, each believing it had exclusive control, and nothing logged it. Serializing per caller cannot work: subagents inherit the parent's `mcp.json` verbatim, so every one of them presents the parent's `callerSessionId` and they are indistinguishable at the transport. The FIFO (`src/main/browser/guest-drive-queue.ts`, a p-queue of one keyed by `webContentsId`, mirroring `withTaskLock`) is therefore keyed by the thing actually contended - the guest - and acquired inside `withGuest` after `resolveLiveGuest`, so `beginAgentInput` / the body / `endAgentInput` all run under it and a queued drive does not announce. Three unbounded bodies were bounded first, because a FIFO turns one stuck holder into everyone's problem: `wait` now acquires per poll rather than holding for its whole 60s, and `navigate` and `eval` carry their own bounds. Honest limits, unchanged by any lock: a mutex does not stop worker A navigating away from the page worker B is mid-verify on, and `cdp.ts`'s `Promise.race` abandons rather than cancels, so a wedged capture still head-of-line-blocks that guest's transport. The reported shape is reproduced end to end by `scripts/rigs/browser-contention/` - three concurrent callers on ONE session id, against a live preview, at zero quota - and verified red-green by disabling the lock: 40 of 120 keystrokes arrive without it, on both a lane and a real task-detail pane, and 120 of 120 with it. Note WHICH way it fails, because it is not the obvious one: concurrent click-then-type sequences race for focus and two callers' input is LOST outright rather than interleaved, so a test that only checks for shredding passes with the fix removed.
22. **A subagent gets its own offscreen LANE, and a lane is not a pane** - one-pane-per-task is assumed by `browserPaneRegistry`'s map, the store's `browserOpenTasks`, and `DetailOwnerRegistry`, and all three are about the user-visible task-detail window. An offscreen lane has no window and no renderer involvement, so it registers into the SAME registry under a synthetic session id carrying `kind: 'lane'`, and `withGuest` / `resolveTarget` / `resolveLiveGuest` need no change at all. Substrate is an offscreen `BrowserWindow` (`offscreen: true`, `show: false`), reusing the worktree partition so a subagent inherits the user's login. Offscreen is not a preference: `initially_hidden` is set only in the NON-offscreen branch of `electron_api_web_contents.cc`, so an offscreen WebContents is never marked hidden and keeps its own compositor - whereas a VISIBLE lane window the user happens to cover stops rendering on Windows and re-enters the `Page.captureScreenshot` hang. Routing is a server-issued handle (`open_pane` with `isolated: true` returns one, passed back as `sessionId`), so the discriminator is the ACT OF ASKING, not who is asking - no `agent_id`, no hook, no adapter capability, and it works for all ten agent CLIs. Hook-stamped `agent_id` routing was designed and rejected: Claude-only, needs a second `EXTERNAL_SCRIPTS` hook script (`event-bridge.js` suppresses stdout by design and `updatedInput` IS stdout), and rests on an undocumented per-instance guarantee. Lane isolation is COOPERATIVE and cannot be enforced, for the same reason per-caller serialization cannot; `list_panes` therefore labels lanes and counts them without handing out other callers' ids.
23. **`LANE_FRAME_RATE` is 10, and that number was measured** - offscreen rendering copies a full frame bitmap on every paint, so lanes are throttled; the first value shipped was 2 and was wrong. Time for a wheel-driven scroll to land: unthrottled 100ms, 10fps 100ms, 2fps 300ms. At 2fps an agent that scrolls and immediately screenshots captures the PRE-scroll frame - a silently wrong answer, which is worse than a slow one. 10fps has no measurable penalty and is still a 6x saving over the default. Capture is unaffected by throttling either way (`Page.captureScreenshot` forces its own frame; an explicit `invalidate()` first produced byte-identical images at every rate tested). Also measured, so it is not re-derived: `sandbox: true` on a lane costs nothing, and `Input.dispatchMouseEvent` genuinely lands on an offscreen guest (the page's listener fired, and a `mouseWheel` actually scrolled) - assert that the PAGE received the input, never merely that the CDP command returned.
24. **An agent's browser survives the user closing the task window** - the pane's guest dies with its DOM node, so a subagent mid-verify lost its browser the moment the user navigated away, and it reported "agent disconnected". Closing a window is a statement about the user's layout, not about the agent's work, so a pane being driven is handed off to a lane (`src/main/browser/browser-lane-handoff.ts`) instead of destroyed. `HANDOFF_REASONS` is an allowlist, not a denylist: `self-heal-dead-guest` is excluded, because a guest the registry just evicted as dead has nothing to hand off and reviving it would resurrect a corpse. Lane lifetime is tied to the OWNING SESSION, never to the subagent - nine of ten agents have no `SubagentStop` hook - with four backstops on existing machinery: `resolveLiveGuest` self-heals a dead entry, session end destroys that session's lanes, an idle timeout reclaims an untouched one, and `detachAll()` sweeps on quit. Two of those were written and initially never called (`destroyLanesForSession`, `touchLane`); a cleanup path with no caller is not a backstop, and the idle reclaim would have reaped ACTIVE lanes without the second.
25. **The dev-port ledger answers a question; it does not assign** - an earlier pass leased a port per task at worktree creation and defaulted the task's pane to it. That was wrong in both halves. A port Kangentic chose is a number the user never configured (the first default, 4200, is ANGULAR's, and a task's pane opened onto a developer's own running dashboard), and a real project pins its own ports - often several - in `angular.json`, a vite config, a compose file. So nothing is reserved up front: `kangentic_reserve_dev_ports` answers "give me N ports nothing else is using", `kangentic_check_dev_ports` reports what a task holds and what is actually listening, and the pane defaults to nothing. What the ledger is FOR is the one thing a project's own config cannot do - see across every task and every project at once, so two agents starting servers at the same moment do not pick the same number. The table is global (`<configDir>/index.db`) for that reason, which scopes it to one Kangentic INSTANCE rather than the machine: `configDir` honours `KANGENTIC_DATA_DIR`, so a `/preview` keeps its own ledger and a reservation does not cross between instances. It is keyed on `task_id` rather than `worktree_path` (a Done round-trip nulls the path), and its index on `task_id` is deliberately non-unique so one task can hold an API and a frontend. A lease is only ever advisory: the authority is a bind probe, which is what stops a port something else already holds from being handed out - the other Kangentic instance included, which is what makes the instance scope above safe. There is no background reclaim, and the two release paths (task delete, project delete) are the whole lifetime - see `dev-port-allocator.ts`'s header for the residual that leaves untreated.

## Files

```
src/main/
  index.ts                                  webview hardening, webviewTag, popup + permission +
                                            download wiring, mid-drive keystroke interception
  window-open-policy.ts                     app-window deny handler + webview popup allow handler
  permission-policy.ts                      first-party and embedded-browser permission predicates
  ipc/handlers/browser.ts                   BROWSER_CAPTURE_SEND, URL persistence
  pty/paste-engine.ts                       paste-and-submit primitive
  pty/write-queue.ts                        bracketed-paste-aware chunking
  browser/browser-url-store.ts              per-task URL overrides
  browser/browser-pane-registry.ts          open panes by sessionId; caller-scoped target resolution
  browser/browser-pane-opener.ts            open/close a pane for the caller's task (MCP lifecycle tools)
  browser/browser-pane-driver.ts            withGuest: gate, resolve, CDP attach, focus emulation,
                                            drive signal, error envelope
  browser/browser-automation-config.ts      resolved Agent Browser policy
  browser/agent-input-signal.ts             refcounted "an agent is driving guest N" burst edges
  browser/embedded-signin-refusal.ts        detects a provider refusing an embedded browser
  browser/webview-download-policy.ts        one will-download handler per guest Session
  browser/guest-drive-queue.ts              per-guest FIFO so concurrent agents cannot interleave
  browser/browser-lane-manager.ts           offscreen BrowserWindow lanes (one per isolated caller)
  browser/browser-lane-handoff.ts           keeps a driven pane alive as a lane when its window closes
  browser/drive-telemetry.ts                per-drive record: caller, pane, queue wait, outcome
  browser/dev-server-error.ts               reads a Vite error overlay as a real dev-server-error
  browser/cdp/                              the single shared CDP driver (+ bounded screenshot)

src/main/dev-ports/
  dev-port-allocator.ts                     reserve N free ports; bind probe is the authority
src/main/db/repositories/
  dev-port-repository.ts                    the global dev_ports ledger
src/main/agent/commands/
  dev-port-commands.ts                      kangentic_reserve_dev_ports / kangentic_check_dev_ports

src/main/agent/mcp-http/
  browser-tools.ts                          the 16 kangentic_browser_* tools

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
  bridge/useBrowserDownloadToast.ts         the download-finished toast + "Show in folder" (decision 13)
  components/
  TaskDetailWindow.tsx                      browser/changes mutually exclusive (task detail is now a modeless window)
src/renderer/components/dialogs/
  task-detail/TaskDetailBody.tsx            2-col layout when Browser is on; owns the drive-visible
                                            treatment - dims the terminal side, accents the pane border
  task-detail/TaskDetailHeader.tsx          Browser pill

src/renderer/stores/
  agent-drive-store.ts                      which sessions have an agent driving their pane, so the
                                            terminal and the pane can show it (HMR-pinned, Pattern E)

src/renderer/utils/
  agent-input-focus-guard.ts                restores the user's focus after a drive; routes an
                                            intercepted keystroke to their terminal, or to the
                                            pane's note input
  text-target.ts                            writing text into a React-controlled input without a
                                            keyboard: the eligibility rule, the native-setter write,
                                            the contenteditable write, and the intercepted-byte
                                            decoder
  guest-text-target.ts                      the same, one process away: the three scripts injected
                                            into a guest page (probe / write / submit)
  browser-navigation-registry.ts            which pane a mouse back/forward gesture acts on
  dictation-target.ts                       which terminal OR text input dictation writes to
  dictation-sink.ts                         how it writes there (PTY bytes vs a DOM write)
  dictation-anchor.ts                       WHERE the dictation chip sits: the anchor for each
                                            target kind, and the pure below/above placement
  terminal-anchor-registry.ts               sessionId -> the element drawing that terminal, so the
                                            chip can anchor to that pane

src/shared/
  ipc-channels.ts                           BROWSER_*
  types.ts                                  BrowserCaptureInput, BrowserPickedElement, AppConfig.browser
  external-url.ts                           EMBEDDED_BROWSER_SCHEMES (pane + popup)
  terminal-key-encoding.ts                  keystroke -> terminal bytes, for intercepted input

tests/unit/
  terminal-submit.test.ts
  terminal-submit-scheduler.test.ts
  write-queue.test.ts
  window-open-policy.test.ts                both handlers + the index.ts wiring scans
  browser-input-focus-emulation.test.ts     the REAL cdp.ts input payloads and focus emulation
  agent-input-focus-guard.test.ts           the guard's three pure decisions
  agent-driven-focus-sites.test.ts          the rule's static scan
  text-target.test.ts                       eligibility, span replacement, and the byte decoder
  dictation-target.test.ts                  the resolver's tiers, including the text-input tier
  terminal-key-encoding.test.ts
  embedded-signin-refusal.test.ts
  webview-download-policy.test.ts
  window-store-agent-open.test.ts

tests/ui/
  agent-open-pane-focus.spec.ts             an agent open never moves focus; a user open still does
  browser-pane-agent-input-focus.spec.ts    the guard restores, and routes intercepted keys
  dictation-note-input.spec.ts              push-to-talk into the note input, driven through the
                                            real hotkey (the only spec needing a fake microphone)

tests/e2e/
  browser-popup-window.spec.ts              real guest: popup exists, origin title, shared Session
```
