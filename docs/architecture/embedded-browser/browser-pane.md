---
type: Reference
title: Embedded browser pane
description: How the Browser pane hardens its webview and keys cookie jars per task, how Draw, Inspect and Send build the XML-tagged capture prompt and paste it through the paste engine, how agents drive the pane with kangentic_browser_* tools, and its settings, limits and zero-quota preview rig.
tags: [browser, webview, capture, paste-engine, agent-driving]
sources:
  - resource: src/renderer/components/browser/
  - resource: src/main/ipc/handlers/browser.ts
  - resource: src/main/pty/paste-engine.ts
  - resource: src/main/pty/terminal-submit.ts
  - resource: src/main/pty/write-queue.ts
  - resource: src/main/agent/mcp-http/browser-tools.ts
  - resource: src/main/window-open-policy.ts
  - resource: src/main/permission-policy.ts
  - resource: src/shared/browser-partition.ts
  - resource: src/shared/external-url.ts
  - resource: src/renderer/window-manager/bridge/useBrowserPaneRequestBridge.ts
  - resource: src/main/index.ts
    title: web-contents-created handler
  - resource: src/shared/types.ts
    title: BrowserCaptureInput, BrowserPickedElement, AppConfig.browser
  - resource: src/main/browser/browser-pane-opener.ts
  - resource: src/main/browser/browser-pane-registry.ts
  - resource: src/main/browser/browser-pane-driver.ts
  - resource: src/main/browser/cdp/
  - resource: src/main/browser/browser-url-store.ts
  - resource: src/main/browser/browser-partition-cleanup.ts
  - resource: src/main/browser/guest-session-policy.ts
  - resource: src/main/browser/agent-input-signal.ts
  - resource: src/main/browser/drive-telemetry.ts
  - resource: src/main/browser/viewport-override-store.ts
  - resource: src/main/browser/viewport-override.ts
  - resource: src/main/browser/browser-lane-manager.ts
  - resource: src/main/browser/browser-lane-handoff.ts
  - resource: src/main/browser/browser-pane-detach.ts
  - resource: src/main/browser/guest-drive-queue.ts
  - resource: src/main/browser/jar-seeder.ts
  - resource: src/main/browser/cookie-seed.ts
  - resource: src/main/browser/browser-automation-config.ts
  - resource: src/main/browser/dev-server-error.ts
---
# Embedded browser pane

A side-pane in the modeless task-detail window (`TaskDetailWindow`) that hosts an Electron `<webview>`, captures the rendered frame plus user annotations + DOM context, and submits it to the active agent as a multi-modal prompt.

A "decision N" below is entry N of the [decision log](decision-log.md).

## User-facing flow

1. Open a task with an active agent session. Click the **Browser** pill in the dialog header (mutually exclusive with **Changes**). The pill only shows and hides: a hidden pane's page is kept alive for the agent. A green running dot on the Browser pill, and a green globe at the right end of the task card's title row, both say a browser guest is running for the task (showing, hidden, or parked). Whether the agent is driving it right now is shown in the pane itself. **Close browser** (the red-tinted button at the far left of the pane's navigation bar, ahead of Back, or the item of the same name in the task menu) is the discard: it ends the page and frees its renderer process; Show then opens the saved URL fresh.
2. First time in a project: the empty-state prompt asks for a URL. Pick a quick-pick (`localhost:3000`, `5173`, `4321`, `8080`) or type one. Submitting auto-saves it as the project default.
3. URL bar supports back/forward/reload, pin to project default, pin to task override.
4. **Draw** mode (`Ctrl/Cmd+D`): free-draw strokes on a transparent overlay above the webview. Pointer-events flip to `none` on the webview while drawing so events reach the canvas.
5. **Inspect** mode (`Ctrl/Cmd+I`, `Esc` to exit): click an element to capture a structured fingerprint (selector, role, ARIA name, testid, classes, ancestors, computed styles, outerHTML). The picked element keeps a blue persistent overlay that follows scroll/resize until cleared. Re-entering Inspect replaces the prior pick.
6. **Send** (`Enter` in the note field, or the Send button): composites webview frame + strokes into a single PNG, captures any text selection, builds an XML-tagged prompt, and submits to the agent's PTY via the paste engine. The note field's `onKeyDown` bails on Shift alone, so `Ctrl/Cmd+Enter` sends as well while `Shift+Enter` stays a no-op. From anywhere else in the dialog it is a no-op: the handler lives on the note field, and the document-level listener that used to fire from anywhere was removed in `15076930` because it hijacked the terminal's `Mod+Enter` newline.

## Architecture

### Security model

The webview is hardened in `src/main/index.ts`:

- `webviewTag: true` on the host `BrowserWindow`.
- `app.on('web-contents-created', ...)` runs `will-attach-webview` to strip `preload`, force `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`. Non-`http(s):` `src` URLs are rewritten to `about:blank`. It also sets `zoomMode: 'isolated'`, so a pane's zoom is its own: in Electron's default mode zoom is stored per origin within the partition, which let one pane's zoom (or an agent's viewport fit) reach every pane, pop-out and lane on the same dev server, and dropped the zoom on a cross-origin navigation while the toolbar still showed it.
- The same handler also sets per-webview policies on the guest's webContents:
  - `applyBrowserUserAgent` drops the `Electron/<version>` token from the guest's user agent and
    its `Session`'s, keeping `Kangentic/<version>`, because some firewalls reject the token as a
    bot (decision 41). The offscreen lane calls it too.
  - `setWindowOpenHandler` allows an http(s) `window.open` / `target=_blank` into a chromed popup
    window on the guest's own session, and denies every other scheme. See decisions 10 to 12.
  - `installEmbeddedBrowserSessionPolicy` (`browser/guest-session-policy.ts`) sets
    `setPermissionRequestHandler` AND `setPermissionCheckHandler`, both reading
    `isEmbeddedBrowserPermissionAllowed` (decision 14), and installs the `will-download` policy
    that saves to the OS Downloads folder, once per `Session` (decision 13). The offscreen lane
    calls it for its own session too. A lane is a BrowserWindow that never reaches this handler,
    so until it did, a lane opened before any pane had used its task's partition ran with
    Electron's default, which grants every permission request.
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

**Cookie isolation:** the webview partition is keyed PER TASK via `browserPartitionForTask(projectId, taskId)` in `src/shared/browser-partition.ts` (returns `persist:kng-<projectId>-<taskId>`, ids hyphen-stripped). Keyed by the TASK, not the worktree path, so the jar follows the task through any relocate/rename/Done round-trip - the path can change, the id cannot. Browser cookies are scoped to HOST not port, so two tasks running dev servers on `localhost:4200` and `:4300` would clobber each other's `localhost` session under one shared jar - therefore each task gets its own persistent jar for localhost, while a per-project identity jar (`persist:kng-<projectId>-identity`) shares the non-localhost (IdP) login across tasks (decision 33). The names are self-describing so the sweep and the clear-storage pass parse a jar back to its project + task. The renderer (`<webview partition>`) and the main process (lane, seeder, clear-storage) derive the same name from the same ids. The legacy single jar `BROWSER_PARTITION` (`persist:kangentic-browser`) remains for the no-project fallback and is also wiped by **Clear browser data**.

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

**No subscription requirement:** the engine observes PTY output through `SessionManager`'s unconditional `data-tap` event (settle, submission evidence, and the paste-mode monitor alike), so it behaves identically for focused and background sessions. The old caller contract (session must be in `focusedSessionIds`) is gone: MCP session-send and mobile-bridge messages routinely target sessions no renderer is subscribed to, and under the renderer-gated `data` event those callers silently degraded to the wall-clock cap with a dead paste-mode guard.

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

- **Opening and closing the pane:** an agent opens its OWN task's pane with `kangentic_browser_open_pane` and puts panes away with `kangentic_browser_close_pane`, so hitting `no-pane-open` is no longer a dead end that forces it to stop and ask the user. Pane open state is renderer-owned (`browserOpenTasks`) while the MCP server is main-process, so this crosses the process boundary: `src/main/browser/browser-pane-opener.ts` validates every precondition in main (the open project, the per-project `browser.enabled` gate, the task row, the URL), pushes `BROWSER_PANE_OPEN_REQUEST` / `BROWSER_PANE_CLOSE_REQUEST` fire-and-forget, and then awaits the PANE REGISTRY rather than an acknowledgement. A close also closes the task's detached Browser window, if one is open, after that push: closing the window docks it back, so the flag has to be cleared first. That is deliberate: a reply saying "I set the flag" would not mean the pane is driveable, whereas a registered live guest does. The renderer half is `useBrowserPaneRequestBridge` (mounted by `WindowLayer`'s `BoardBridges`), which opens the pane before requesting the window so the window mounts with the pane already showing rather than changing tree shape one commit later. Opening seeds the task's URL sidecar first, because a pane with no URL renders the empty state and registers no guest at all. See [Browser panes](../../integrations/mcp-server/browser-panes.md#browser-automation-tool-surface-kangentic_browser_) for the tools' arguments and scoping.
- **Registration:** the renderer registers each open pane's guest webContents id (`webview.getWebContentsId()`) with the main process on `dom-ready`, via `BROWSER_PANE_REGISTER` / `BROWSER_PANE_UNREGISTER` IPC, and unregisters that same guest id on unmount. The main-process pane registry (`src/main/browser/browser-pane-registry.ts`) mints a surface HANDLE per guest (`pane_<8hex>`; a lane's is `lane_<8hex>`) and records the guest's taskId and owning agent session beside it, so the tools target one tab per handle for that tab's whole life: re-registering the same guest (a `/clear` rotates the owning session) updates the owner in place and keeps the handle, a different guest always gets a new one, and a handle whose guest is gone answers `surface-gone` naming the replacement (see decision 34). Main also tracks the guest's own `destroyed` / `did-navigate` so the registry stays honest across a hard reload. The tracked URL is a fallback, not the reported value: `kangentic_browser_list_panes` reads each pane's URL live from the guest, because `did-navigate` never fires for same-document navigation and a dev server's SPA routing, `pushState`, and fragment changes would otherwise leave the cache reporting a URL the pane had left. The cache is used only when the guest is gone or has no URL to report yet.
- **Driving (in-process):** the driver (`src/main/browser/browser-pane-driver.ts`) resolves the target, attaches Chrome DevTools Protocol to the guest webContents, and runs the shared CDP helpers in `src/main/browser/cdp/` (the same content-agnostic driver the dev inspection bridge uses through a compat shim). No HTTP bridge, no lockfile: the pane is in the same process as the MCP server. Debuggers detach synchronously on `before-quit`.
- **Gating:** the global **Agent Browser** settings tab (master enable + per-capability switches: interaction, navigation, eval, restrict-to-localhost) is read live per tool call. `eval` is off by default. See [Browser panes](../../integrations/mcp-server/browser-panes.md#browser-automation-tool-surface-kangentic_browser_) and `.claude/rules/browser-automation-driver.md`.

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
- `AppConfig.browser.enabled` (project-overridable) - when `false`, the Browser pill in `TaskDetailHeader` is hidden AND `kangentic_browser_open_pane` refuses with `browser-pane-disabled`. The MCP side is enforced in main rather than left to the UI: `TaskDetailBody` renders the pane on its open (or held) flag alone, so a pane opened while this gate is off would show with no pill beside it, and the pill is the user's only way to hide it. Default `true`.
- **Clear browser data** - destructive action backed by `IPC.BROWSER_CLEAR_STORAGE` (`src/main/ipc/handlers/browser.ts`). The pane is isolated per task (decision 1), so a project has one jar per task plus its identity jar; the handler enumerates all of them via `enumerateProjectPartitions` (`src/main/browser/browser-partition-cleanup.ts`), which prefix-scans `<userData>/Partitions` for `kng-<thisProjectId>-*` (plus the identity jar and the legacy shared jar) - no DB touched. For each it calls `clearStorageData(...)` for cookies, localStorage, IndexedDB, shadercache, cachestorage, and serviceworkers, then `clearCache()` and `clearAuthCache()`, clearing the jars concurrently. Wrapped in a danger-variant `ConfirmDialog` with `showDontAskAgain: false` (a one-shot destructive action should not be suppressible). Per-task URL overrides (`.kangentic/browser-urls.json`) and the project default URL are intentionally left alone. Those are workflow state, not browsing identity. The success toast prompts the user to reload any open browser pane to apply the cleared state, since `clearStorageData` does not refresh in-flight documents. Jars for deleted tasks or projects are reclaimed automatically by the startup sweep (see decision 32).

The Browser tab in `AppSettingsPanel` (per-project, above the separator) exposes all three. Future additions (per-task draw color, capture history) belong here.

- **Agent Browser** (global, below the separator) - a separate tab (`AppConfig.browserAutomation`) gating the `kangentic_browser_*` agent tools: `enabled` (master), `allowInteraction`, `allowNavigation`, `allowEval` (default off), `restrictNavigationToLocalhost` (default off). This is a cross-project security policy, hence global, whereas the per-project Browser tab is pane workflow.

## Limitations and future work

| Item | Status | Tracked |
|---|---|---|
| Per-adapter submission verification (replace heuristic data-byte fallback) | Done | `getSubmissionVerifier(contextType)` declared on every adapter; engine consumes via `PasteOptions.verifier` |
| Clear browser data action in settings | Done | `IPC.BROWSER_CLEAR_STORAGE`; see Settings above |
| Orphaned cookie jars from deleted tasks and projects | Done | reclaimed by a startup sweep over `<userData>/Partitions`; see decision 32 |
| Carrying an IdP login across a project's tasks so sign-in is not repeated | Done | non-localhost (IdP) cookies shared project-wide via the identity jar, localhost isolated; empirically confirmed a copied Google session authenticates; see decision 33 |
| Pop-out window for second-monitor workflow | Done | child `BrowserWindow` via the pop-out surface registry; see decision 7 |
| DOM tree picker (vs free-form `getSelection()`) | Future | nice-to-have |
| File downloads from embedded webview | Done | saved to the OS Downloads folder with a toast; see decision 13 |
| Permission requests (camera, mic, geo) from embedded webview | Done | deny-by-default request AND check handlers on the guest session; see decisions 5 and 14 |
| `window.open` / `target=_blank` popups | Done | chromed popup on the guest's own session; see decisions 10 to 12 |
| First-party Google sign-in inside the pane (navigate to `accounts.google.com`) | Works | empirically confirmed 2026-08-26: completes and yields a full authenticated session; see decisions 15 and 33 |
| Google OAuth "Sign in with Google" popup (third-party federated) | Unverified | Google returned `disallowed_useragent` to the popup while it sent the `Electron/` token (decision 15). The token is gone since decision 41 and the popup has not been re-tested; the refusal detector stays either way |
| An agent-opened window stealing the user's keyboard focus | Done | `openedByAgent` stamp + an exclusive arrival-focus tier; see decision 16 |
| Focus moving into the pane while an agent drives it | Accepted, and SHOWN | unavoidable: driving a page means clicking it, and a click focuses the guest. The terminal dims, the pane is marked "Agent typing here", and stray keystrokes are still routed to the terminal. Three attempts to eliminate it were built, measured, and reverted; see decisions 18 and 19 |
| Selector-less `type` / `keypress` | Refused unless the pane holds focus | a key sent while focus is elsewhere lands there, the user's terminal included, so every key is checked first and refused with `pane-not-focused`. Both tools take a `selector` to click first in the same call; see decision 18 |
| Dictation into the pane's note input | Done | a focused text field wins over every terminal tier, and the transcript is written with the native value setter; see decision 21 |
| Dictation in the rest of the app | Done | allow-by-default: any focused text field is a target, so no surface has to opt in; see decision 21 |
| Auto-submit committing a half-written form | Done | release presses Enter only where Enter commits ONE field; a form with two or more text inputs inserts without submitting; see decision 21 |
| Dictation into a text field inside the GUEST PAGE | Done | `<webview>.executeJavaScript` reaches the guest's focused field directly; password fields refuse, and dictation fills but never submits. A cross-origin iframe stays unreachable (top frame only); see decision 24 |
| An intercepted keystroke aimed at the note input | Done | delivered to the field (printable characters and Backspace only, Enter still dropped) instead of being lost; see decision 21 |
| The dictation chip landing on the split seam and covering pane controls | Done | it anchors to the target itself (the field, or the terminal's own pane) rather than to the window, whose centre IS the seam; see decision 22 |
| Scroll primitive | Done | `kangentic_browser_scroll` dispatches a real `mouseWheel`, optionally centred on a selector; see decision 40. Note that the KEYS which normally scroll (PageUp / PageDown / Home / End) are delivered without their default action, so `keypress` is not a scroll path |
| `keypress` chord on a digit or punctuation key | Done | the event names the real key: `Digit1` for `Ctrl+1`, `Backquote` (virtual key 192) for Ctrl plus a backtick, from `chordKeyIdentity` in `cdp/key-combo.ts`. It used to send `Key1` and the character code, so a page matching `event.code` never fired. A character with no key of its own on a US keyboard carries no `code` |
| Modifier-click (Ctrl/Shift+click) | Future | no way to send a modified click; `click` takes no modifier argument |
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
   caller's own task (`.claude/rules/browser-automation-driver.md`). Connecting to `/mcp/<projectId>` gets the
   refusal on a preview AND on the dogfooding app; connecting to
   `/mcp/<projectId>/<callerSessionId>` works on both.
2. **A Browser pane needs a live session to exist**, because the session is recorded as the
   owner of its registry entry (the entry itself is keyed by a per-guest surface handle) and keys
   its capture directory and its paste target.

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
- **Unit (browser policy)** - `window-open-policy.test.ts` (both handlers: the app window's deny-and-route-out, and the pane's popup allow plus `hardenWebviewPopupWindow`; plus an AST scan of `index.ts` pinning that `applyBrowserUserAgent(contents)` is a direct statement of the `web-contents-created` handler body, after the webview-type guard), `embedded-signin-refusal.test.ts`, `webview-download-policy.test.ts`, `browser-user-agent.test.ts`, `browser-lane-manager.test.ts` (including that a lane sets its user agent before its first load), `browser-partition.test.ts`, `browser-pane-driver.test.ts`, `browser-pane-registry.test.ts`, `browser-pane-opener.test.ts`, `browser-automation-config.test.ts`, `browser-automation-invariants.test.ts`. The cookie-jar mechanisms behind decisions 32 and 33 have their own four: `browser-partition-cleanup.test.ts` (the orphan sweep and its abstain rules), `cookie-seed.test.ts` (the copy primitive's edge table), `jar-seeder.test.ts` (load-boundary sync + write-back mirror), and `cookie-jar-sharing.test.ts` (the `.claude/rules/cookie-jar-sharing.md` chokepoint scan).
- **Unit (input and focus)** - `browser-input-focus-emulation.test.ts` drives the REAL `cdp.ts` through a spying fake debugger and pins the mouse/key payloads, the scroll-into-view ordering, and the focus-emulation lifecycle; `agent-input-focus-guard.test.ts` pins the guard's three pure decisions, including that a text target arms even inside the pane while a non-text element there still does not; `terminal-arrival-focus.test.ts` pins the `agent-window` tier; `window-store-agent-open.test.ts` pins the `openedByAgent` stamp; `agent-input-burst.test.ts` pins the burst debounce behind decision 20 (one begin for a run of back-to-back calls, the end waiting for the quiet window, and `isAgentDriving` covering the tail); `browser-keyboard-focus.test.ts` pins `keyboardFocusIsInHost` over host, host-subframe, guest, cross-site-iframe and null focused frames (failing closed when the frame cannot be read) and drives the real `cdp.ts` through the decision 18 refusals; `browser-tools-drive-bodies.test.ts` pins `keypress`'s click-then-press order and its pre-click `unknown-key` refusal.
- **Unit (chip placement, decision 22)** - `dictation-anchor.test.ts` pins the placement arithmetic against rects measured from a REAL split window, so its cases are the actual failure rather than an invented one: the chip stays inside its own pane, centres on the pane, rests above the agent's input box for the whole utterance, clears the five rows that box occupies, survives a pane shorter than the reserve, moves only when the PANE does, and flips above at the exact boundary. The DOM half - that `resolveDictationAnchor` finds the right elements at all, and that the chip does NOT move when the xterm caret does - is covered by three cases in `dictation-note-input.spec.ts`.
- **Unit (text targets, decision 21)** - `text-target.test.ts` pins eligibility (allow-by-default: enabled, text-shaped, never `password`, never xterm's helper textarea, and an explicit `data-no-text-target` opt-out), that a revised transcript replaces its anchored span rather than appending, and that the byte decoder drops Enter, Tab, Escape, and the CSI sequences. `dictation-target.test.ts` pins that a focused text input outranks even a visible, focused Command Terminal, and that an excluded one falls through unchanged.
- **UI** - `browser-empty-state`, `browser-pane-active`, `browser-pane-refetch-guard`, `browser-pane-registration` (the guest-identity spec), `browser-pane-request-bridge`, `browser-pane-shortcuts`, `browser-pill-gate`, `browser-settings`, plus `agent-open-pane-focus` and `browser-pane-agent-input-focus` for the focus work, and `dictation-note-input` for decision 21 (the only spec in the tree that needs a microphone, so it launches its own browser with Chromium's fake media device; no assertion depends on the audio content).
- **E2E** - `browser-send-roundtrip.spec.ts`, `browser-ctrl-enter-pty.spec.ts`, `browser-evidence-retry.spec.ts`, `browser-popup-window.spec.ts` (the only tier with a real guest, so the only place the popup's origin title, its shared `Session`, its opener link, and the absence of the `Electron/` token from the guest's and the popup's user agent can be checked at all), and `browser-agent-key-focus.spec.ts` (drives the real MCP tools against a live guest on CI's Linux: a selector-less key with the terminal focused is refused and reaches neither the host document nor the page, a selector delivers it, and `type` submits a form on a newline while respecting a keydown filter).
- **Not mechanically testable, and deliberately left to the live rig above:** whether Chromium's real
  focus propagation is suppressed (no tier has a live `<webview>` guest), whether a popup's
  `postMessage` reaches the pane's page (the E2E pins the opener link itself: the handle, `closed`
  and the main-side `opener`), and whether Google's refusal URL still matches.

## Files

```
src/main/
  index.ts                                  webview hardening, webviewTag, user agent + popup +
                                            permission + download wiring, mid-drive keystroke
                                            interception
  window-open-policy.ts                     app-window deny handler + webview popup allow handler
  permission-policy.ts                      first-party and embedded-browser permission predicates
  browser/guest-session-policy.ts           permission + download policy for a pane or lane session
  ipc/handlers/browser.ts                   BROWSER_CAPTURE_SEND, URL persistence
  pty/paste-engine.ts                       paste-and-submit primitive
  pty/write-queue.ts                        bracketed-paste-aware chunking
  browser/browser-url-store.ts              per-task URL overrides
  browser/browser-pane-registry.ts          open surfaces by per-guest handle; caller-scoped,
                                            own-task-only target resolution; retired-handle memory
  browser/browser-pane-opener.ts            open/close a pane for the caller's task (MCP lifecycle tools)
  browser/browser-pane-driver.ts            withGuest: gate, resolve, CDP attach, focus emulation,
                                            drive signal, error envelope
  browser/browser-automation-config.ts      resolved Agent Browser policy
  browser/agent-input-signal.ts             refcounted "an agent is driving guest N" burst edges
  browser/embedded-signin-refusal.ts        detects a provider refusing an embedded browser
  browser/webview-download-policy.ts        one will-download handler per guest Session
  browser/browser-user-agent.ts             drops the Electron/ token from a guest's user agent (decision 41)
  browser/guest-drive-queue.ts              per-guest FIFO so concurrent agents cannot interleave
  browser/browser-lane-manager.ts           the OFFSCREEN form of a task's one surface (decision 39)
  browser/browser-lane-handoff.ts           keeps a driven pane alive offscreen when its window
                                            closes, reclaims it when the pane returns, and destroys one
                                            whose agent ended while it was still opening
  browser/viewport-override.ts              the three viewport mechanisms + measure-and-report (decision 38)
  browser/viewport-override-store.ts        which surface is under which override (importable anywhere)
  browser/browser-pane-detach.ts            pop the caller's pane into its own window, and dock it back
  browser/drive-telemetry.ts                per-drive record: caller, pane, queue wait, outcome
  browser/dev-server-error.ts               reads a Vite error overlay as a real dev-server-error
  browser/browser-partition-cleanup.ts      enumerate (clear-storage) + sweep orphaned task jars (decision 32)
  browser/cookie-seed.ts                    shared cookie-copy primitive (rig + seeding)
  browser/jar-seeder.ts                     share IdP login across a project's tasks, isolate localhost (decision 33)
  browser/cdp/                              the single shared CDP driver (+ bounded screenshot)

src/shared/
  browser-partition.ts                      task-keyed partition names + self-describing dir parsing

src/devtools/main/
  cookie-jar-routes.ts                      dev-only cookie experiment rig (list/copy jars)

src/main/dev-ports/
  dev-port-allocator.ts                     reserve N free ports; bind probe is the authority
src/main/db/repositories/
  dev-port-repository.ts                    the global dev_ports ledger
src/main/agent/commands/
  dev-port-commands.ts                      kangentic_reserve_dev_ports / kangentic_check_dev_ports

src/main/agent/mcp-http/
  browser-tools.ts                          the 26 kangentic_browser_* tools

src/renderer/components/browser/
  BrowserPane.tsx                           top-level component (loading/empty/active)
  BrowserEmptyState.tsx                     URL prompt + quick picks + WSL hint
  close-browser.ts                          the user's Close discard (retire the handle, then unmount)
  AttachmentChips.tsx                       chip strip (strokes, picked element)
  captureComposite.ts                       PNG compositor
  useDrawingOverlay.ts                      stroke capture
  useBrowserUrl.ts                          URL resolution hook
  inspectScript.ts                          element-picker + persistent overlay
  webview-types.ts                          structural types for <webview>

src/renderer/window-manager/
  bridge/retained-task-snapshots.ts         frozen task rows a retained window renders from
  bridge/window-parking.ts                  park-on-close policy + the reaper that ends a park (decisions 35, 36)
  bridge/useBrowserPaneRequestBridge.ts     applies main's open/close pane pushes to browserOpenTasks
  bridge/useBrowserDownloadToast.ts         the download-finished toast; a click shows the file in its folder (decision 13)
  components/
  TaskDetailWindow.tsx                      browser/changes mutually exclusive (task detail is now a modeless window)
src/renderer/components/dialogs/
  task-detail/TaskDetailBody.tsx            2-col layout when Browser is on; owns the drive-visible
                                            treatment - dims the terminal side, accents the pane border
  task-detail/TaskDetailHeader.tsx          Browser pill

src/renderer/stores/
  agent-drive-store.ts                      which sessions have an agent driving their pane, so the
                                            terminal and the pane can show it (HMR-pinned, Pattern E)
  session-store.ts                          owns browserOpenTasks / browserHeldTasks /
                                            browserGuestTasks via its task-changes-panel slice.
                                            HMR-pinned (Pattern E) but deliberately NOT
                                            self-accepting: it sits in an import cycle, and Vite
                                            answers a circular-import invalidate with a full page
                                            reload, which kills every guest
  session-lifecycle-hooks.ts                late-bound session actions for project-store, so
                                            project-store no longer imports session-store (that
                                            cycle was reloading the page on every store-slice save;
                                            the session-store -> project-store edge remains, but
                                            one direction is not a cycle)

scripts/
  hmr-guest-probe.mjs                       measures whether an edit destroys a live pane guest:
                                            reload? same webContentsId? pane remounted? plus Vite's
                                            own reload reason. Exits non-zero when the guest dies

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
  browser-user-agent.test.ts                the stripped string, and both halves of a guest getting it
  window-store-agent-open.test.ts

tests/ui/
  agent-open-pane-focus.spec.ts             an agent open never moves focus; a user open still does
  browser-pane-agent-input-focus.spec.ts    the guard restores, and routes intercepted keys
  dictation-note-input.spec.ts              push-to-talk into the note input, driven through the
                                            real hotkey (the only spec needing a fake microphone)

tests/e2e/
  browser-popup-window.spec.ts              real guest: popup exists, origin title, shared Session,
                                            no Electron/ token in the guest or popup user agent
```
