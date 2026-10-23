---
type: Reference
title: Browser panes
description: "How agents open, list, close, pop out and resize the embedded Browser pane over MCP: surface handles and surface-gone, the one-surface-per-task rule with its offscreen lane fallback and hand-off, Agent Browser gating, and set_viewport's zoom-to-fit emulation."
tags: [mcp, browser, panes]
sources:
  - resource: src/main/agent/mcp-http/browser-tools.ts
  - resource: src/main/browser/browser-pane-opener.ts
  - resource: src/main/browser/browser-pane-registry.ts
  - resource: src/main/browser/browser-lane-manager.ts
  - resource: src/main/browser/browser-lane-handoff.ts
  - resource: src/main/browser/browser-pane-detach.ts
  - resource: src/main/browser/viewport-override.ts
  - resource: src/main/browser/browser-automation-config.ts
---
# Browser panes

## Browser automation tool surface (`kangentic_browser_*`)

These **shipped** tools let an agent drive the embedded **Browser pane** of a task (an Electron `<webview>` showing the user's own dev server, e.g. `ng serve` on `http://localhost:4200`). They are distinct from the dev-only `kangentic_devtools_*` tools in [Dev-only inspection tools](devtools.md), which debug Kangentic itself. They attach Chrome DevTools Protocol to the pane's guest webContents in-process (no HTTP bridge, no lockfile). Implementation: `src/main/agent/mcp-http/browser-tools.ts` plus `src/main/browser/` (pane registry, driver, shared CDP driver).

Targeting is scoped to the connection's own project (the `<projectId>` segment of the MCP URL). Every **driving** tool (navigate, observe, interact, eval) takes an optional `sessionId` or `taskId`. `sessionId` is a **browser surface handle** (`pane_<8hex>` for a visible pane, `lane_<8hex>` for an offscreen lane), as returned by `kangentic_browser_open_pane` and `kangentic_browser_list_panes`; it is not a Kangentic agent session id. A handle names exactly one guest webContents (one tab) for its whole life: registering the same guest again (a `/clear` rotates the owning session) keeps it, and a new guest always gets a new one, so a handle can never silently retarget to a different tab. When the tab behind a handle is gone, the call fails with `surface-gone`, which says why it went (the task window was closed, the lane was closed, the tab was destroyed), how long ago, that per-tab state (`sessionStorage`, in-memory app state) did not carry over while cookies and `localStorage` did, and names the task's current surface to use instead. A value that was never a handle (an agent session id, say) is refused as `no-pane-open` with the same pointer. Either target must name a surface in the caller's project; one in another project is refused with the `foreign-project` error kind.

Omit both and the implicit default is **own-task-only** for a caller bound to a task: it resolves among that task's surfaces, ranked visible pane first, then the offscreen form of it, and refuses `multiple-panes` (with candidates) when two share the best rank or `no-pane-open` when the task has none. It never falls through to another task's pane, however many are open in the project; that fall-through was observed navigating a sibling task's logged-in app to an identity-provider URL. Only a caller with no task (a human-driven client, a Command Terminal, or the two-segment `.kangentic/mcp-config.json` URL) uses the project-wide rule: a surface its own session owns, then the single pane open in the project, else `multiple-panes` with candidates. An explicit `taskId` ranks the same way. `kangentic_browser_list_panes` lists the surfaces you can drive.

No tool in the family takes a `project` argument, so there is no way to *drive* another project's pane. Two tools sit outside the driving rule above, both deliberately:

- `kangentic_browser_open_pane` takes neither `sessionId` nor `taskId`, because it always targets the caller's own task.
- `kangentic_browser_close_pane` reaches other projects only on an explicit `includeOtherProjects`, which widens `all` and also lets an explicitly named foreign `sessionId` / `taskId` resolve. That is a deliberate carve-out for "close all browsers": closing a pane is not reading or controlling someone else's page, and retention keeps a backgrounded project's panes alive, so those are exactly what such a request should reach. Without the flag it stays scoped like everything else. Note the asymmetry - a foreign pane can be *seen* (`list_panes` with `includeOtherProjects`) and *closed*, never driven.

Gating: the global **Agent Browser** settings tab controls the family, read live per request. `browserAutomation.enabled` is the master switch: when off, the entire `kangentic_browser_*` family is not registered, so the tools never appear in `tools/list` and the instructions omit their guidance section (they would be unusable anyway, and advertising them is wasted context). When `enabled` is on, the sub-capability gates apply: `allowInteraction` gates click/type/keypress/drag (off = observe-only); `allowNavigation` gates navigate; `allowEval` gates eval (off by default); `restrictNavigationToLocalhost` confines navigation to localhost/private hosts (off by default). With `enabled` on, each tool returns an actionable `{ kind, detail }` error when one of those sub-capabilities is gated off, when no driveable pane exists (`no-pane-open`), when the named pane belongs to another project (`foreign-project`), or when the window holding the pane is minimized and therefore composites no frames (`pane-not-rendering`). Screenshots have a further constraint: a window that is hidden or fully occluded also stops compositing, and Electron cannot report that to the main process, so `pane-not-rendering` does not catch it. Those captures instead fail after a short bound with a `driver-error` telling the user to bring the window to the front. Non-pixel tools (`query_dom`, `click`, `type`, and the rest) are unaffected and keep working against a backgrounded pane.

Tool categories (26 tools):
- **Discovery:** `kangentic_browser_list_panes` - list the Browser panes open in your project and their URLs. Each entry carries `sameProject` and `driveable`, and the response reports `otherProjectPaneCount` / `unknownProjectPaneCount` so an empty list is never mistaken for an idle machine. Pass `includeOtherProjects: true` to also list other projects' panes, which are visible but not driveable
- **Lifecycle:** `kangentic_browser_open_pane`, `kangentic_browser_close_pane` - open and put away panes (below)
- **Navigate:** `kangentic_browser_navigate` - point the pane at an http(s) URL; `kangentic_browser_history` - go back or forward
- **Observe:** `kangentic_browser_screenshot`, `kangentic_browser_screenshot_element`, `kangentic_browser_query_dom`, `kangentic_browser_query_all`, `kangentic_browser_bounding_box`, `kangentic_browser_console`, `kangentic_browser_network`, `kangentic_browser_wait`
- **Interact:** `kangentic_browser_click`, `kangentic_browser_hover`, `kangentic_browser_type`, `kangentic_browser_keypress`, `kangentic_browser_scroll`, `kangentic_browser_drag`, `kangentic_browser_select_option`, `kangentic_browser_drop_files`, `kangentic_browser_handle_dialog`
- **Viewport:** `kangentic_browser_set_viewport` - render at a chosen width and height; `kangentic_browser_pop_out`, `kangentic_browser_dock` - move the pane between the task window and its own OS window. See [Choosing a viewport](#choosing-a-viewport)
- **Eval:** `kangentic_browser_eval` - evaluate a JavaScript expression in the loaded page; gated by `browserAutomation.allowEval`

### kangentic_browser_open_pane

`kangentic_browser_open_pane` opens the Browser pane for the **caller's own task** and loads a URL, so an agent that hits `no-pane-open` can get itself unstuck instead of stopping to ask the user. It takes no `sessionId` / `taskId`: naming another task is exactly the cross-project hole the caller-scoping work closed, so the target is always the caller's own task and there is no argument that can widen it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | No | Absolute http(s) URL to load. Falls back to the task's saved Browser URL, then the project default. |

That is the whole input. A task has exactly one browser surface, so there is nothing to choose:
see [One browser surface per task](#one-browser-surface-per-task) for the `isolated` argument that
used to be here and why it was removed.

The URL is part of the same call by necessity: a pane with no URL renders the empty state and registers no `<webview>` guest, so it is invisible to `list_panes`, `navigate`, `screenshot`, and every other tool in the family. An open-without-navigate would strand the agent in a state nothing can act on. When no `url` is passed and neither fallback exists, the tool fails with `no-url` rather than opening an unusable pane.

Behavior worth knowing:

- **It opens the task's detail window if one is not already open.** That changes what is on the user's screen, which is deliberate: refusing would put the agent right back at the dead end this tool exists to remove.
- **It returns only once the pane is registered and driveable**, resolved through the same `withGuest` chokepoint every driving tool uses, so the agent's very next call cannot race it. The wait is bounded (10s), after which it fails with `pane-open-timeout`. The one exception is a call that navigates nothing (the pane is already open and no `url` was passed): that returns the pane's registry status directly, having confirmed the guest is live but not that it is driveable.
- **It is idempotent.** Called again with a different `url`, it navigates the existing pane rather than reopening it; the response's `opened` / `navigated` flags say which happened.
- **It shows a hidden pane again.** A pane the user hid with the Browser pill (held) or whose window the user closed while the agent was live (parked) is still registered and driveable, so the call takes the warm path, and it also asks the renderer to show the pane and un-park the window: the same guest and tab, nothing reloads, and the window it raises is agent-stamped so its terminal never takes the user's keyboard. Only `close_pane` discards.
- **The pane it returns carries `visibility`**, the same field [`kangentic_browser_list_panes`](#kangentic_browser_list_panes) reports (`showing` / `hidden` / `parked`, or `offscreen` for a lane). Every value is driveable; it tells you whether the user can currently see what you are doing. On a warm call this is a snapshot taken BEFORE the re-surface push is applied, so a pane that was hidden or parked can still report that here even though it is being shown. Call `list_panes` afterwards if you need the settled value.
- **It carries the `navigate` capability tier**, since it always loads a URL. Turning off "Allow navigation" in the Agent Browser settings therefore disables this tool too. The tier is checked before anything happens, so a gated-off call never opens a window or seeds a URL first.
- **A backgrounded project gets the surface OFFSCREEN rather than a refusal.** The board window layer renders only the open project's tasks, so no pane can mount for a backgrounded one. The response then carries `offscreen: true` and a `laneId`; the surface is fully driveable, the user sees it exists on the task card, and it becomes a real pane the moment one can mount. This replaced a `project-not-open` refusal that composed with the `no-pane-open` hint into a loop.
- Refusals it can return besides the shared ones: `no-caller-task` (the connection is not bound to a task, e.g. a Command Terminal), `browser-pane-disabled` (the project has the Browser pane turned off), `task-not-found`, `no-url` (no `url` passed and no fallback readable - for a backgrounded project neither fallback can be read at all, so pass one), `surface-opening` (the task's surface is still loading its first page; retry), `surface-exists` (a second surface for one task, which the callers prevent), `app-not-ready` (Kangentic is still starting, or its window is gone - also reachable from `close_pane`), and `url-seed-failed` (the URL could not be persisted before the pane was opened).

### kangentic_browser_close_pane

`kangentic_browser_close_pane` discards panes exactly as the user's Close browser control does (the Browser pill only hides, keeping the guest alive for you). It closes the pane, never the task-detail window hosting it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Close the pane for this session. |
| `taskId` | string | No | Close the pane for this task. |
| `all` | boolean | No | Close every pane in scope instead of a single target. Use for "close all browsers". Takes precedence over `sessionId` / `taskId`, which are ignored when set. |
| `includeOtherProjects` | boolean | No | Also close panes belonging to other projects. Widens `all` and an explicitly named target; it does not widen a bare no-argument call, which always means "my own pane". Default false. |

With no arguments it resolves the caller's own pane through the same precedence chain the driving tools use. Unlike opening, it does **not** require the caller's project to be the one currently open: retention keeps a backgrounded project's panes alive, and those are exactly what a "close everything" request should reach.

Scope is the caller's project by default, and the response always names the scope it applied (`this-project` / `all-projects`) plus `otherProjectPaneCount` for what it left alone, so a partial close is never reported as complete. `includeOtherProjects: true` is the explicit opt-in for a genuinely global close; it is off by default because another project may have an agent mid-verification in its pane. The response's `closed` and `skipped` arrays report what actually happened rather than what was attempted: a pane detached into its own pop-out window is the expected straggler, since it is mutually exclusive with the in-app mount and clearing the open flag does not unmount it.

Cookie isolation is per task (`persist:kng-<projectId>-<taskId>`) so concurrent tasks' dev environments never share a `localhost` cookie jar, while the per-project identity jar (`persist:kng-<projectId>-identity`) shares non-localhost (IdP) logins across tasks. See [Embedded browser pane](../../architecture/embedded-browser/browser-pane.md#security-model).

### An agent's browser survives the window closing

A browser an agent is using belongs to the agent, not to a piece of UI. The user is free to close the
task detail, move around the board, and switch projects without disconnecting an agent midway through
verifying something.

An Electron `<webview>` guest dies the instant its DOM node unmounts, so a visible pane that
genuinely unmounts (a hard reload, the pane detaching into a pop-out, a task-detail window that had
to be dropped) is destroyed. When that happens and the task still has a live agent session, main
hands the page off to an offscreen lane at the same URL, registered under a NEW `lane_` handle for
the same task. An agent that omits `sessionId` resolves to it through the own-task rule, which ranks
a hand-off lane right behind the visible pane. An agent holding the old `pane_` handle is told the
truth rather than retargeted: that handle now returns `surface-gone`, naming the lane and saying
that per-tab state did not carry over (the lane is a fresh document in the same cookie jar).
Reopening the task's Browser pane stands the hand-off lane down, because the visible pane is the
better answer whenever it exists and two surfaces for one task would make every implicit call
ambiguous; `open_pane` itself never counts a hand-off lane as "already open" and always mounts the
visible pane. A pane the agent put away with `close_pane` is never handed off.

This is distinct from retention (`.claude/rules/retained-pane-never-remounts.md`), which keeps the
guest mounted, hidden, so it never unmounts at all: across a project switch, when the user closes a
task window whose agent is still live (the window is parked and reopening re-attaches the same tab),
and when the user hides the pane with the Browser pill or opens Changes over it (the pane is held
behind the full-width terminal and showing it again is a style change). In every one of those the
handle, the CDP session, `sessionStorage`, and in-memory state are intact, and the tools keep working
on the hidden page. Retention covers the guest surviving; the hand-off covers the guest genuinely
going away. Three things discard a pane: `close_pane`, the session ending, and the user's own Close browser
(the red button at the far left of the pane's navigation bar, or the same item in the task
menu, which is how a hidden or parked pane is closed). The user's hide never does. A user stop retires the handle with reason
`user-closed` and deliberately stands up NO hand-off lane, since the user closed it to get the
guest's memory back; the agent's next call gets `surface-gone: the user closed the browser` with
the `open_pane` hint, and reopening is allowed.

### One browser surface per task

A task has exactly ONE browser surface. It is normally the visible `<webview>` pane; when no pane
can be mounted it comes up OFFSCREEN instead, as a main-process `BrowserWindow` whose handle is a
`lane_` id. Both forms answer to the same tools and the same handle rules. There is no argument for
a second surface, and none for choosing the offscreen form.

`kangentic_browser_open_pane` took an `isolated: true` argument until 2026-09-21, and it is gone.
The case for it was concurrency: several agents under one task would otherwise resolve to the same
pane and interleave navigations, clicks and screenshots while each believed it had exclusive
control. That concurrency was never real - parallel callers already contend for a single guest and
are serialized by the drive queue, so four lanes bought a queue with four heads rather than four
workers. The cost was real. An offscreen surface sets no entry in the renderer map the card globe
and the Browser pill read (written only on a `<webview>`'s `dom-ready`), so nothing in the UI said
one existed, the user could not close it, and every supervision guard built for the pane - the
veil, the accent ring, the label, the pointer block - reached none of it. Reported from live use: a
user closed the Browser pane, and the agent completed a whole verification run in a lane with no
browser anywhere on screen.

What replaces it:

- **The offscreen form is a FALLBACK, not a choice.** `open_pane` opens the visible pane whenever
  one can mount. It falls back to offscreen only when the caller's project is not the one currently
  open in Kangentic, because the board window layer renders only the open project's tasks and no
  window can be mounted for a backgrounded one. The response then carries `offscreen: true` and a
  `laneId`, so an agent can say the user is not watching rather than reporting a browser they
  cannot see. The fallback stays because removing it recreates a dead end: every drive returns
  `no-pane-open`, whose hint says to call `open_pane`, which used to refuse `project-not-open`.
- **The offscreen surface is visible in the UI.** Main pushes the set of tasks holding one to the
  renderer, so the task card's globe and the task-detail Browser pill light up for it exactly as
  they do for a pane, and the task menu's "Close browser" destroys it.
- **Opening the Browser pill RECLAIMS it.** The pane mounts at the offscreen surface's current URL
  (read from the live guest, not from the saved sidecar, which only a pane ever writes), and the
  pane's registration destroys the offscreen one. Mechanically a re-create rather than a move: a
  `webContents` cannot migrate from a `BrowserWindow` into a `<webview>` tag, so the page reloads
  and `sessionStorage` is lost. Cookies and localStorage survive (same partition). The agent's old
  handle answers `surface-gone` naming the replacement, which is the same compromise `pop_out` and
  `dock` already make.
- **A second surface for one task is refused** (`surface-exists`, naming the one that exists).
  Both callers check first, so this is a structural guarantee rather than a path an agent reaches.
  The reachable neighbour is `surface-opening`: a surface enters its bookkeeping before it loads
  its first URL and registers only after, so for up to the load deadline it is neither driveable
  nor absent. That answer says to retry, rather than naming a handle whose every drive would
  answer `no-pane-open`.

The rest of the offscreen surface's behaviour is unchanged. It shares the task's cookie jar, so it
inherits whatever the user is already signed into. One whose first URL does not load within the
load deadline returns `lane-load-failed` and is destroyed rather than left half-open, so a dev
server that is still starting reads as a retryable failure instead of a hang. It is destroyed when
the session that opened it ends, when it goes idle, when the app's main window closes, and on app
quit, so forgetting about one leaks nothing. An `open_pane` that races one of those teardowns
returns `lane-swept` rather than a handle: retry once, since a sweep from a closed window is over by
then but a quitting app keeps refusing.

`kangentic_browser_list_panes` reports each surface's `kind` (`pane` or `lane`) so an agent can tell
which form its task's surface is currently in.

### kangentic_browser_list_panes

List the Browser surfaces open in your project, so you can discover a surface handle (`sessionId`) or `taskId` to drive or confirm the user has a dev server loaded. Returns an empty list when no pane is open. Not a driving tool: it takes no target pair.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeOtherProjects` | boolean | No | Also list panes in other projects. They are listed for visibility only and cannot be driven from this connection. Default false. |

Returns `{ automationEnabled, projectId, panes, otherProjectPaneCount, unknownProjectPaneCount }`. Each surface carries its handle (`sessionId`, the value to pass back), `ownerSessionId` (the agent session it serves), `taskId`, `kind` (`pane` for the visible pane, `lane` for the offscreen form of the same one surface), `visibility` (`showing`: the user can see it; `hidden`: the user hid it behind the terminal with the Browser pill; `parked`: the user closed its window; `offscreen`: a lane. Every value is still driveable; this says whether the user can see what you do, not whether you may act), `webContentsId`, current URL, liveness / debugger-attached state, plus `sameProject` and `driveable`. The two counts are why an empty `panes` list is never mistaken for an idle machine. A pane the user CLOSED (the pane's red "Close browser" button or the task menu's item of the same name) is not listed at all: its handle answers `surface-gone` saying the user closed the browser, and `open_pane` opens a fresh one.

### Choosing a viewport

A docked pane is only as wide as the task window's split leaves it, which in practice is a few hundred CSS pixels below every desktop breakpoint. An agent verifying a responsive layout there measures the mobile rendering and reports it as the desktop one, so three tools exist to choose the viewport deliberately. They are not interchangeable, and the difference that matters is what each costs the page:

| Mechanism | Viewport control | Page state | Surface handle |
|-----------|------------------|------------|----------------|
| `set_viewport` on a docked pane (device emulation) | Exact width and height, any value, including larger than the physical screen | Preserved. No reload; `sessionStorage`, in-memory state, scroll and auth all survive | Unchanged |
| `set_viewport`'s `zoom`, on any surface | Renders larger or smaller. Does not change the requested layout size: the override is scaled to compensate | Preserved | Unchanged |
| `set_viewport` on an offscreen surface or an already-detached window | Real pixels, capped by the display for a window, uncapped offscreen | Preserved, because nothing moves | Unchanged |
| `pop_out` / `dock` (the move itself) | Not a viewport control, a relocation | **Lost.** Fresh `<webview>`, the page reloads, `sessionStorage` gone. Cookies and localStorage survive, since the jar is keyed by task | **New.** The old handle answers `surface-gone` naming the replacement |

So the context-preserving route to any resolution is `set_viewport` on the surface you already hold, and it is the one to reach for mid-flow. `pop_out` buys real OS pixels and a window the user can drag, and charges the page's in-memory state for it.

**Asking for a size zooms the pane to fit it.** Emulation changes the layout viewport without changing the widget, so a 1920px layout in a 740px pane would show only its left third while the pane's chip claimed 1920 - the number and the picture disagreeing. So a docked pane is zoomed out to fit, and the user sees the whole layout. Pass `zoom: 1` to opt out and get the 1:1 crop instead.

Three measured facts make that work, and none is obvious:

- **Zoom multiplies an override.** A page lays out at override divided by zoom, so a 1920px override at zoom 0.4 produced a 4800px layout. The override is therefore pre-scaled by the zoom, which puts the requested number back in `innerWidth`.
- **A screenshot is the pane's pixels, whatever the layout.** A fitted 1600x1000 layout in a 740x749 pane comes back 740x463 on a 100% display, and about 1480x926 at 200%. The override is sent at the display's own scale factor, so the page's `devicePixelRatio` is that factor times the zoom, the same as any page zoomed out that far. The first version sent `deviceScaleFactor = 1/zoom` to keep screenshots at the requested resolution, and that is what made every capture come back tiled: a guest capture cannot hold more pixels than its pane (see [`kangentic_browser_screenshot`](browser-actions.md#kangentic_browser_screenshot)). The "came back at 1920x1079" that justified it checked the image's decoded size and never its pixels. For detail, `kangentic_browser_screenshot_element` captures a region at up to 1:1 even on a fitted page, and `pop_out` gives a real window whose viewport screenshots are 1:1. A popped-out pane is still a `<webview>`, so a full page or an element larger than that window is scaled to fit it the same way.
- **`scale` is deliberately never sent.** Chromium's own fit-to-widget scaling is the one configuration where CDP mouse coordinates stop matching `DOM.getBoxModel`: measured at `scale: 0.385`, a click on a box-model centroid landed on `<html>` instead of the target and still reported success. The zoom-based fit above is what replaces it, and a click still lands under it.

Two smaller behaviours worth knowing:

- **A maximized window is un-maximized before it is resized.** `setContentSize` is silently ignored while a window is maximized or full screen, so an agent that popped out maximized and then asked for half the size got the same bounds back twice. Asking for a specific size is taken as a request to leave that state.
- **A window resize CONVERGES rather than correcting once.** Measured live: a 1280x720 request came back 1203x601, and the next request came back 1203x601 again, because `unmaximize()` animates and discards a same-tick `setContentSize`. The resize now measures, asks for the shortfall and measures again, up to three passes, and reports whatever it reached.
- **A window is kept on its display, and can be placed on it.** `setContentSize` keeps the top-left and grows right and down, so a window part-way across a multi-monitor desktop and sized to the full work area runs onto the next screen. It is pulled back inside after every resize, and `position` places it deliberately. The bound is `getDisplayMatching(...).workArea`, re-read per call, so an ultrawide gets its real width, a laptop beside an external is bounded by whichever screen holds the window, and different scale factors are handled.
- **The measurement is `innerWidth`, not the content box.** `Page.getLayoutMetrics` reports `clientWidth`, which has the scrollbar removed, so a 1920 request measured 1905 on any scrolling page and `exact` went false for a reason that was not a clamp.

### kangentic_browser_set_viewport

Set the viewport a Browser surface lays out against, and report the one it actually got. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `width` | number | No | Viewport width in CSS pixels, 128 to 8192. Omit to keep the current width. |
| `height` | number | No | Viewport height in CSS pixels, 128 to 8192. Omit to keep the current height. |
| `deviceScaleFactor` | number | No | The `devicePixelRatio` the page sees, 0 to 4, for testing hidpi assets. Default 0, meaning the display's own, scaled by the zoom like any zoomed page. Docked panes only; a window renders at its display's own factor, and the response says the value was ignored. It changes which assets the page loads, and a screenshot's density follows it only as far as the pane's pixels allow: a small viewport at a high ratio can come back denser, while a fitted desktop layout stays at the pane's resolution. Leave it out otherwise: a ratio the display does not have is emulated, and a canvas sized from device pixels can draw blank under it. Measured on the web demo, xterm's WebGL terminals went black at `deviceScaleFactor: 1` on a fitted pane and rendered normally at the default. |
| `zoom` | number | No | Page zoom factor, the same one the pane's zoom pill shows. Omitted, a docked pane is zoomed to fit the requested size. Pass 1 to show the user a 1:1 crop instead. Screenshots are the whole viewport either way. |
| `position` | string | No | Where to put a DETACHED window on its display: `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right`. With `width` and `height` this is a window snap: half the display width plus `left` docks it to the left half. Ignored with an explanation on a docked pane and on a lane. |
| `reset` | boolean | No | Drop the override, restore the zoom the fit changed, and return the surface to its natural size. Ignores `width` and `height`. |

Returns `{ mechanism, requested, viewport, deviceScaleFactor, zoom, display, maxWindowViewport, exact, visibleFraction, note }`. `display` is the work area of the display the surface is on, and `maxWindowViewport` the largest viewport a real window there can reach (null except on the window path). `viewport` is **measured from the page** after the change settles, never the request echoed back, and `exact` is false when the two differ: a window loses its frame and the pane's own chrome to the viewport and is capped by the display, a lane can be clamped, and an override composes with whatever zoom is set. `mechanism` names which of the three paths ran (`device-emulation`, `window-resize`, `lane-resize`), chosen from the surface rather than from an argument. `deviceScaleFactor` is likewise measured: the page's own `devicePixelRatio`, never the factor sent to Chromium, which on a fitted pane is the requested ratio divided by the zoom. On a docked pane, `note` also says what size a screenshot of the viewport will come back at when that is below 1:1.

Behavior worth knowing:

- **An override outlives the call.** It is CDP-session scoped, not document scoped, so it survives a navigation. It ends on `reset: true`, when the agent's session ends, when the user clears it from the pane's viewport chip, or when the pane closes.
- **`reset` restores the zoom the fit changed, and only that.** The value is captured on the first override, so a pane the agent never sized keeps the user's zoom untouched and a user who re-zoomed mid-drive is not overridden by a stale reading.
- Error modes beyond the shared set: `invalid-viewport` for a dimension outside the range, and `driver-error` when the surface's window has gone (a lane reclaimed, a detached window closed mid-call).

### kangentic_browser_pop_out

Detach the **caller's own** task Browser pane into its own OS window, optionally at a given size. Capability tier: `navigate`, since the move reloads the page at its URL. Takes no `sessionId` / `taskId`, for the same reason `open_pane` does not.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `width` | number | No | Requested viewport width in CSS pixels. Capped by the physical display; the response reports what the page got. |
| `height` | number | No | Requested viewport height in CSS pixels. Same capping and reporting. |
| `maximized` | boolean | No | Open the window maximized instead of at a given size. |
| `position` | string | No | Where to place the window on its display, as the nine-point anchor `set_viewport` takes. |

Returns `{ moved, pane, sessionId, viewport?, note }`. **Use the returned `sessionId` from then on:** the window mounts a fresh `<webview>`, so the previous handle is dead and answers `surface-gone`. Like `open_pane`, it returns only once the new pane is registered and driveable, bounded at 20s (`detach-timeout` past that).

Called when a window is already open, it resizes that window rather than opening a second one, and reports `moved: false`.

Two behaviors worth knowing:

- **It does not take the user's keyboard focus.** The window is shown inactive, per `.claude/rules/agent-driven-focus.md`: an agent action never moves focus.
- **A size it applies is not saved as the user's.** Pop-out bounds persist per surface KIND rather than per task, so persisting an agent's testing viewport would overwrite the window size the user chose, for every task. A later resize by the user persists normally.

Other refusals: `no-caller-task`, `no-pane-open` (open a pane first), `detach-failed`.

### kangentic_browser_dock

Put the caller's detached Browser window back into the task, undoing `kangentic_browser_pop_out`. Capability tier: `navigate`. Takes no parameters.

Returns the same shape as `pop_out`. Docking moves the page too, so it reloads and mints another new handle: use the `sessionId` this returns. Error mode beyond the shared set: `not-detached` when the pane is already in the task window.
