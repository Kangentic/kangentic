---
type: Reference
title: Browser actions
description: "The kangentic_browser_* tools that act on the loaded page: navigate, screenshot, DOM queries, console, network, click, type, keypress, drag, scroll, file drop, dialogs and eval, with their parameters, capability tiers and error kinds."
tags: [mcp, browser, automation]
sources:
  - resource: src/main/agent/mcp-http/browser-tools.ts
  - resource: src/main/browser/browser-pane-driver.ts
  - resource: src/main/browser/guest-drive-queue.ts
  - resource: src/main/browser/dev-server-error.ts
---
# Browser actions

## Shared target parameters

Every **driving** tool below takes the same optional target pair. They are listed in each tool's table for completeness; the resolution precedence and the `foreign-project` rule are described once, in [Browser panes](browser-panes.md#browser-automation-tool-surface-kangentic_browser_).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Browser surface handle (`pane_…` / `lane_…`) from `open_pane` / `list_panes`. Names one tab for its lifetime; a gone tab returns `surface-gone` naming the replacement. Must be in your own project. |
| `taskId` | string | No | Task whose Browser surface to target (visible pane first, then a lane). An alternative to `sessionId`, likewise same-project. |

Omitting both resolves your own task's surface (a caller with no task falls back to the single pane open in the project). Alongside the per-tool errors listed below, any driving tool can return the shared refusals raised while resolving and attaching to a pane: `no-pane-open`, `surface-gone` (the handle named a tab that no longer exists; the detail names the task's current surface), `multiple-panes` (more than one surface shares the best rank and neither argument was given; the error carries the candidates), `foreign-project`, `pane-destroyed`, `pane-not-rendering`, `cdp-attach-failed`, `pane-busy`, and `driver-error`.

## Drive serialization and capability refusals

Drives against one pane are SERIALIZED. Only one runs at a time per guest, so two agents sharing a
pane get slow-but-correct behavior instead of interleaved clicks, keystrokes and navigations. A
drive that cannot get its turn within 30s returns `pane-busy` rather than hanging. Serialization
fixes interleaving, not intent: it cannot stop another agent navigating away from the page you were
midway through verifying. There is no longer a way to take a separate surface, deliberately - see
[One browser surface per task](browser-panes.md#one-browser-surface-per-task) for why the
separate-surface answer was worse than the problem. Concurrent workers on one task share the queue
and should coordinate rather than assume exclusive control.

The capability gate (`capabilityGate` in `src/main/browser/browser-pane-driver.ts`, the single source of the tier rules) adds four more: `automation-disabled` when the master switch is off, and `interaction-disabled` / `navigation-disabled` / `eval-disabled` for the tool's own tier. `automation-disabled` is reachable even though the family is not registered while the master switch is off, because the policy is read live per request: a switch flipped mid-session refuses the next call rather than waiting for a reconnect.

## kangentic_browser_navigate

Point the pane at an http(s) URL. This navigates the in-app pane the user has open, not a general web browser; the pane's URL bar and the per-task saved URL both update. Capability tier: `navigate`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `url` | string | Yes | Absolute http(s) URL to load, e.g. `http://localhost:4200`. |

Returns `{ ok: true, url }` with the validated URL. The URL is checked before the pane is resolved, so a malformed URL or a non-http(s) scheme (`invalid-url`), or a non-local host while `restrictNavigationToLocalhost` is on (`navigation-host-blocked`), is refused without touching the pane.

## kangentic_browser_screenshot

Capture the pane's loaded page and return an inline image plus viewport and scale metadata for mapping image coordinates back to the page. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `fullPage` | boolean | No | Capture the full scrollable page instead of the viewport. Default false. On a pane the page is scaled down to fit the pane's own pixels. |
| `format` | string | No | `png` or `jpeg`. Default `jpeg`. |
| `quality` | number | No | JPEG quality 1-100, ignored for png. Defaults to 80 for jpeg. |
| `maxBytes` | number | No | Soft cap on decoded image bytes; the capture downscales and recompresses to fit. |

The metadata carries `pixelsPerCssPixel`, the number to divide an image coordinate by for the page's CSS one. It is not always `deviceScaleFactor`, the page's own ratio: a capture scaled to fit its pane or a byte budget holds fewer pixels than the page renders at. `note` appears when the pane is the reason a capture is small, and says where to go for detail.

**A pane's screenshot holds no more pixels than the pane has.** That is Chromium, not a setting. A `<webview>` guest cannot grow its view for a capture the way a tab can, and when a capture asks for more pixels than the guest's widget holds, Chromium fills the difference by repeating the widget. The image comes back tiled, the page repeated in a grid of pane-sized blocks. So every capture of a docked or popped-out pane is planned to fit inside `pane width x pane height x display scale`, and a larger request is scaled down rather than tiled: a 1600x1000 viewport in a 740x749 pane on a 100% display comes back 740x463. Should one ever come back larger anyway, the call fails with a `driver-error` naming the pane's size instead of returning the tiled image. An offscreen surface is a real window whose view Chromium can grow, so it is not bounded.

Error modes beyond the shared set: `screenshot-failed` when CDP returns no data. A window that is minimized, hidden or fully occluded composites no frames and cannot be detected as such from the main process, so those captures fail after a 5 s bound (`SCREENSHOT_TIMEOUT_MS`) with a `driver-error`. On Windows a locked screen counts as occluded. The error says a retry will not help until the window is on screen again, and to verify through the tools that need no pixels (`query_dom`, `query_all`, `click`), which keep working against that same backgrounded pane.

`kangentic_browser_screenshot` additionally returns `dev-server-error` when the dev server is showing
a build-error overlay. Without it the tool returns a faithful picture of a full-screen red overlay,
which costs a turn to interpret - and when several agents share one dev server, the one that sees the
overlay is usually not the one who broke the build, so the error names that possibility. Detection is
by custom element (`vite-error-overlay`, `nextjs-portal`), so a dev server that renders neither
behaves exactly as before: no overlay recognized means "nothing detected", never "the page is fine".

## kangentic_browser_screenshot_element

Capture a screenshot clipped to a single element, at up to 1:1 (one image pixel per CSS pixel, or the page's own `devicePixelRatio` when that is higher). The element is re-rendered at that density even when the page is zoomed out to fit a wide viewport, so this is the tool for reading detail in a desktop-width layout on a narrow pane. An element too large for the pane at that density comes back scaled to fit, with a `note`. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `selector` | string | Yes | CSS selector (or `text=` / `aria=` form) of the element to capture. |
| `format` | string | No | `png` or `jpeg`. Default `png`. |
| `quality` | number | No | JPEG quality 1-100, ignored for png. |
| `maxBytes` | number | No | Soft cap on decoded image bytes. |

Error modes: `selector-not-found` when nothing matches, `screenshot-failed` when the clip returns no data.

## kangentic_browser_query_dom

Read the `outerHTML` of the first element matching a selector. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `selector` | string | No | CSS selector (or `text=` / `aria=` form). Defaults to `html`. |
| `includeBox` | boolean | No | Also return the element's `{x, y, width, height}` viewport box. |

Returns `{ selector, outerHTML }`, plus `box` when `includeBox` is set. `box` is `null` when the element matched but CDP returned no usable box model. Error mode: `selector-not-found`.

## kangentic_browser_query_all

Measure every element matching a selector in one round-trip, instead of one call per element. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `selector` | string | Yes | CSS selector (or `text=` / `aria=` form). |
| `includeHtml` | boolean | No | Include each element's `outerHTML`, clipped to 1024 characters. |
| `limit` | number | No | Max elements to return. Default 100, max 1000. |

Returns one entry per match with its tag, box, and attributes (attributes are always included). Error modes: `evaluate-failed` when the page-side query throws, `query-failed` when it returns nothing.

## kangentic_browser_bounding_box

Read the raw CDP box model (content, padding, border, and margin quads) of one element. Use `query_dom` with `includeBox` for the simpler rectangle. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `selector` | string | Yes | CSS selector of the element. |

Returns `{ selector, ...boxModel }`. Error mode: `selector-not-found`.

## kangentic_browser_console

Read console messages captured from the pane. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `since` | string | No | ISO timestamp; only return entries at or after this time. |
| `level` | string | No | One of `log`, `warn`, `error`, `info`, `debug`, `verbose`, `all`. Default `all`. |
| `limit` | number | No | Max entries, newest last. Default 100, max 500. |

Each entry is `{ ts, level, text, url, lineNumber }`. The underlying ring holds the most recent 500 messages per attached pane and starts filling when the debugger attaches, so messages logged before that are not retrievable. This is the product tool for the user's own page, separate from the dev-only `kangentic_devtools_console`, which reads Kangentic's own renderer.

## kangentic_browser_wait

Poll until an element appears, optionally containing text, or until a string appears anywhere in the body. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `selector` | string | No | CSS selector to wait for. |
| `domText` | string | No | Text to wait for, within `selector` if given, else anywhere in `body`. |
| `timeoutMs` | number | No | Max wait. Default 30000, max 60000. |
| `intervalMs` | number | No | Poll interval. Default 250, max 5000. |

Returns `{ matched: true, matchedAt }` or `{ matched: false, timedOutAfterMs }`. A timeout is an ordinary result, not an error, so check `matched` rather than assuming success. Error mode: `missing-condition` when neither `selector` nor `domText` is given.

## kangentic_browser_click

Click an element by selector, or a point by coordinates. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `selector` | string | No | CSS selector (or `text=` / `aria=` form) to click at its center. |
| `x` | number | No | X coordinate. Use with `y` instead of `selector`. |
| `y` | number | No | Y coordinate. |
| `coordSpace` | string | No | `viewport` (default) or `image`, which maps the pixels of a full-viewport screenshot back through the `pixelsPerCssPixel` that screenshot reported when its `scale` is 1. A screenshot shrunk to fit `maxBytes` (`scale` below 1) holds fewer pixels, so divide by its own `pixelsPerCssPixel` and pass viewport coordinates instead. |

Pass either `selector` or both `x` and `y`. Returns `{ ok: true }`, plus the mapped `dispatched: { x, y }` on the coordinate path. Error modes: `selector-not-found`, `missing-target` when neither form is supplied, and `coord-mapping-failed` when `coordSpace: "image"` is used but the screenshot density could not be read.

## kangentic_browser_type

Type text into the pane. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `text` | string | Yes | Text to type. |
| `selector` | string | No | CSS selector to focus before typing. Focus is taken by clicking the element's center. |
| `clearFirst` | boolean | No | Select-all and delete before typing. Requires `selector`, since it runs as part of focusing. |

Returns `{ ok: true }`. Error modes: `selector-not-found`, and `pane-not-focused` when the pane does not hold keyboard focus. With no `selector`, the text goes to whatever the page currently has focused, which works only while the pane itself holds keyboard focus. Chromium delivers a key to whatever widget holds focus in the window, and between calls that is usually the user's terminal, so every key is checked first and refused rather than sent there. Keys sent before a refusal were delivered.

A newline in `text` presses Enter carrying `\r`, so it submits a form or starts a new line the way a real Enter does, and a `\r\n` pair counts as one newline. That is how `{selector, text: "query\n"}` types and submits in one call.

## kangentic_browser_keypress

Send a key or chord. Single printable characters are typed. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `keys` | string | Yes | Key or chord, e.g. `Enter`, `Escape`, `Tab`, `Ctrl+Shift+P`, `ArrowDown`. |
| `selector` | string | No | CSS selector of the element to click before pressing, in the same call, so it holds keyboard focus. An `<iframe>` selector works, since the click lands inside the frame. |

Returns `{ ok: true }`. Error modes: `unknown-key` when the combo cannot be parsed, checked before anything touches the page so a bad combo never costs the `selector`'s click; `selector-not-found`; and `pane-not-focused` when the pane does not hold keyboard focus at the moment the key is sent. That refusal is the common case without a `selector`, because the user's focus returns to their terminal between calls and a key sent then would reach the terminal. An agent's Escape there interrupted the agent that sent it. It can also fire with a `selector`, when focus left the pane after the click.

Enter carries `\r`, so it submits a form or starts a textarea line the way a real Enter does; with Ctrl, Alt, or Meta held it carries none, because that is a shortcut. The navigation keys (PageUp, PageDown, Home, End) reach the page without their browser default action.

## kangentic_browser_drag

Drag from one element to another: mouse press, move in steps, release. Every move holds the left
button (`buttons: 1`), as a real drag reports it, so a page that ends a drag on a buttonless move
sees the whole drag. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `fromSelector` | string | Yes | CSS selector of the drag source. |
| `toSelector` | string | Yes | CSS selector of the drop target. |
| `steps` | number | No | Intermediate move steps. Default 10, max 60. Raise it for libraries that need several move events to register a drag. |

Returns `{ ok: true }`. Error mode: `selector-not-found`, which covers either selector failing to match.

## kangentic_browser_hover

Move the pointer over an element without pressing, so a hover menu opens, a tooltip appears, or a hover-revealed control renders. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `selector` | string | Yes | CSS selector of the element to hover. Scrolled into view first. |

Returns `{ ok: true }`. Error mode: `selector-not-found`.

`kangentic_browser_click` already sends a `mouseMoved` before its press, so this is not a step you need before clicking. It exists for VERIFYING hover state, which was previously unreachable: there was no way to open a hover menu and then screenshot it.

## kangentic_browser_scroll

Scroll the page, or one scrollable element, by a wheel delta. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `deltaY` | number | No | Vertical scroll in CSS pixels. Positive scrolls down. |
| `deltaX` | number | No | Horizontal scroll in CSS pixels. Positive scrolls right. |
| `selector` | string | No | A scrollable element to scroll instead of the page. |

Returns `{ ok: true, viewport }`, the viewport measured after the scroll. Error modes: `invalid-scroll` (both deltas zero or omitted, which would do nothing) and `selector-not-found`.

This is how you reach content below the fold, and the only way. Measured against a live guest: `kangentic_browser_keypress` delivers PageDown to the page WITHOUT the browser's default action, so two of them left `scrollY` at 0, and `kangentic_browser_eval` (`window.scrollBy`) is gated off by default. Before this tool the family had no scroll at all.

Note where the wheel is aimed. With no `selector` it is dispatched at the viewport CENTRE, so a scrollable element sitting under that point scrolls instead of the page - which is the same rule a real wheel follows, and it bit during this tool's own verification. Pass a `selector` when you mean a particular scroller, or aim at a non-scrollable element when you mean the page. The event is a real `mouseWheel`, so momentum, scroll-snap and `scroll` listeners all behave as they do for a user.

## kangentic_browser_select_option

Choose an option in a native `<select>`. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `selector` | string | Yes | CSS selector of the `<select>`. |
| `value` | string | No | The option's `value` attribute. |
| `label` | string | No | The option's visible text, matched after trimming. |
| `index` | number | No | Zero-based option index. |

Pass exactly one of `value` / `label` / `index`. Returns `{ ok: true, value }` with the value that ended up selected. Error modes: `missing-target` (none of the three given), `selector-not-found`, `not-a-select` (the selector matched something else), and `no-match` (it is a `<select>` but no option matched; the detail says to read the options with `query_all` on `"<selector> option"`).

Clicking cannot do this, which is why it needs its own tool: the list a `<select>` opens is drawn by the operating system outside the page, so a synthesized press reaches the control and then has nothing to aim at. A custom dropdown built from divs is ordinary UI and wants `click` instead. The tool fires `input` and `change`, so framework bindings react exactly as they do for a real choice.

## kangentic_browser_drop_files

Drop real files onto an element, exactly as dragging them out of the file manager would. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `selector` | string | Yes | CSS selector of the drop target. |
| `paths` | string[] | Yes | Absolute file paths on this machine, 1 to 20. |

Returns `{ ok: true, dropped }`. Error mode: `selector-not-found`.

The page receives genuine `File` objects through `dataTransfer.files`, each backed by its real path. That is the one hop page script cannot fake - a `new File()` built in the page has no path - so this is the only way to test a drop zone or a file input end to end.

## kangentic_browser_history

Go back or forward in the pane's history, the way its own arrows do. Capability tier: `navigate`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `direction` | string | Yes | `back` or `forward`. |

Returns `{ ok: true, url }`, read after the navigation commits rather than before it. Error mode: `no-history`, which refuses rather than silently doing nothing when there is nowhere to go.

## kangentic_browser_network

List the requests the page has made. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `limit` | number | No | Most recent N requests. Default 50, max 300. |
| `urlContains` | string | No | Only requests whose URL contains this substring, e.g. `/api/`. |
| `failedOnly` | boolean | No | Only requests that failed or returned status >= 400. |

Returns `{ requests, returned, total }`. Each request carries `method`, `url`, `resourceType`, `status`, `errorText` and `durationMs`.

The console only shows what the page chose to log, so "did that POST fire, and what did it return" was previously unanswerable. A request still IN FLIGHT is listed with a null status rather than hidden: a dev server that accepted the connection and went quiet is usually the answer you are looking for, and omitting it would make the list say the page finished loading when it did not. The ring holds the last 300 settled requests per CDP session.

## kangentic_browser_handle_dialog

Decide how the page's JavaScript dialogs are answered, and read the ones already seen. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `accept` | boolean | No | True to press OK, false to Cancel. Default false. |
| `promptText` | string | No | Text to enter for a `prompt()`. Only used when `accept` is true. |
| `persist` | boolean | No | True to answer every later dialog this way. Default false: the arm is consumed by the next dialog, then reverts to dismiss. |

Returns `{ armed, seen }` - what the next dialog will get, and every dialog this pane has raised with its type, message and how it was answered.

**Arm it BEFORE the action that triggers the dialog.** A dialog blocks the renderer while it is open, so there is no moment afterwards in which a tool call could answer it - the call itself would hang. An agent that wants to get through a `confirm()` calls this with `accept: true`, then clicks.

**Every dialog is answered whether you call this or not**, and that is what stops a pane wedging. Kangentic enables the CDP `Page` domain, which moves dialogs off Chromium's own UI and onto the debugger; a dialog nobody answers would then block the page with nothing on screen for the user to dismiss, and every later call would queue behind it until the drive lock timed out. The default is DISMISS, which is the safe direction for all four types: cancel a `confirm`, decline a `prompt`, stay on the page for a `beforeunload`.

Enabling `Page` is only half of it. Measured on Electron 41, Electron's own dialog delegate still fires alongside the CDP route, so both ran: the page took the CDP answer and carried on while a native box stayed on screen whose buttons then did nothing, because the answer had already been given. The guest is therefore created with `disableDialogs: true`, which is what actually removes the duplicate. `prompt()` is a separate case: Electron does not implement it, so it throws in the page instead of opening a dialog, and `promptText` is unreachable for a `<webview>` guest. It stays in the API because the CDP path handles it correctly if a future runtime delivers one.

## kangentic_browser_eval

Evaluate a JavaScript expression in the loaded page's origin and return its value. Capability tier: `eval`, which is **off by default**: turn it on at Settings > Agent Browser > Allow eval.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target a surface by its handle. |
| `taskId` | string | No | Target a surface by task. |
| `expression` | string | Yes | JavaScript expression to evaluate. The resolved value is returned. |

Returns `{ value }` with the serialized result. Error mode: `evaluate-failed`, carrying the page-side error text.
