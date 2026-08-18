---
paths:
  - "src/main/browser/**"
  - "src/main/agent/mcp-http/browser-tools.ts"
  - "src/renderer/components/browser/**"
  - "src/renderer/window-manager/**"
  - "src/renderer/utils/terminal-arrival-focus.ts"
  - "src/renderer/utils/agent-input-focus-guard.ts"
  - "src/renderer/stores/agent-drive-store.ts"
---

# Rule: an agent never takes the user's keyboard focus silently

The `kangentic_browser_*` tools drive the user's own running app, on the user's own screen, while
the user is doing something else. Two paths took the keyboard mid-keystroke, and neither was a bug
in the tool's own logic.

Measured on Electron 41 against a live guest, with the terminal focused in an OS-focused window:
one `Input.dispatchMouseEvent` moved `document.activeElement` from the terminal's
`xterm-helper-textarea` to the `<webview>` and flipped `document.hasFocus()` to false. The guest
took REAL focus, so the rest of what the user was typing went into the page. Separately,
`kangentic_browser_open_pane` opened a task-detail window, which set `focusedWindowId`, which made
`resolveArrivalFocus`'s tier 2 match for that window - so its arriving terminal legitimately took
focus out of the terminal the user was actually in. Both were the absence of a rule saying an
agent's actions are not the user's.

## The rule

**An agent action never moves the user's keyboard focus invisibly or unboundedly.** Split by case,
because one of the three cannot be eliminated and the honest rule says so:

- A window open never moves focus. A mount-time `autoFocus` never moves focus.
- A CDP click DOES move focus into the guest, unavoidably: that is how a page gets focused at all,
  and it is the same mechanism a user's own click uses. That case is bounded to the burst, SHOWN
  while it lasts, restored when it ends, and any keystroke the user makes meanwhile is routed to
  their terminal rather than the page.
- The driver never takes guest focus on its own, outside a click.

This is the browser-side analogue of [[terminal-arrival-focus]]'s "an arriving terminal never
decides its own focus", and it holds across the main/renderer boundary. Where it differs is that a
terminal's arrival is always deferrable, and a click's focus effect is not - so this rule bounds and
reveals what that one cannot avoid.

- **The driver NEVER takes the guest's keyboard focus.** Focus moves only as the side effect of a
  synthesized click, and the renderer guard hands it back. This is the KISS position, and it was
  reached by building the alternative and measuring it.

  An implementation that acquired guest focus for interact drives (`focusGuestFromEmbedder`, an
  awaited `executeJavaScript` round trip that focused the `<webview>` element) existed for one day.
  Against a live guest it put the agent's OWN text into the user's terminal: 28 characters, then 95,
  then 207, as each mitigation was added. A `<webview>` is an out-of-process iframe, so acquiring
  its focus is asynchronous and never atomic - the embedder's `document.activeElement` becomes the
  `<webview>` while the real widget focus is still crossing the process boundary, and anything
  dispatched in that gap goes to whichever widget still holds focus. Every version of holding focus
  across calls is a race with the user, who can take it back mid-dispatch. Do not rebuild it.

  Two related facts, both measured, worth keeping:

  - `webContents.focus()` **cannot focus a guest at all.** Electron early-returns for one, to avoid
    a fatal NOTREACHED in `WebContentsViewChildFrame` (`electron_api_web_contents.cc`).
  - `Emulation.setFocusEmulationEnabled` does not affect input ROUTING. Measured in the guest:
    `document.hasFocus()` was `true` while keys were being dropped. It changes what the page
    BELIEVES, which is worth having - a page that hides UI or pauses on blur behaves normally under
    automation - but it is not what makes a keystroke land. Do **not** hoist that call into
    `attachDebugger`: the dev inspection bridge attaches through the same function against
    Kangentic's OWN window (`src/devtools/install.ts`), where a permanently-focused page changes
    `document.hasFocus()` under the app itself.

  The consequence is a KNOWN LIMITATION rather than a bug to fix: `kangentic_browser_type` and
  `_keypress` WITHOUT a selector only land when the pane already holds focus. The selector forms
  work because the click and the characters happen inside ONE call, which is the only configuration
  that measured clean. It is recorded in `docs/embedded-browser.md`.
- **The focus move is SHOWN, not hidden.** This is the design, and it is what the three failed
  attempts above were replaced with. While a burst is open the terminal side of the split dims
  (`opacity` only - it stays mounted, live, and one click away), the pane takes an accent border,
  and the toolbar says "Agent typing here" in words. `agent-drive-store.ts` holds the state, keyed by
  sessionId; `BrowserPane` owns the translation from the guest id the signal carries, because it is
  the only component that knows both.

  Colour is not the whole signal on purpose: the text cue is what makes "why has my typing stopped
  appearing" answerable, and colour alone is not readable by everyone.

  The interception stays as the safety net underneath, so a user who types anyway still lands in
  their terminal rather than a web form. Visible state and safe routing are complements here, not
  alternatives.
- **The renderer sees a BURST, not a call.** `endAgentInput` debounces its announcement by
  `DRIVE_BURST_QUIET_MS`, and a call arriving inside that window cancels it. Without this the pane
  handed focus back between every consecutive tool call: measured at 810 trusted `focusin` events on
  the terminal during one drive, versus 11 with the debounce. Each of those restores was also a
  window in which the next call's keystrokes could land somewhere other than the guest.
- **Every CDP-driving call announces itself, and the renderer restores.** `withGuest` calls
  `beginAgentInput` / `endAgentInput` (`src/main/browser/agent-input-signal.ts`) around `fn`, with
  the end in a `finally` so a throwing tool still ends the guard. The signal is refcounted, so
  overlapping drives on one pane emit only the outer edges.
- **A keystroke the user makes DURING a drive never reaches the page.** Restoring focus after the
  drive is not enough on its own: for the tens-to-hundreds of milliseconds a drive lasts, the guest
  genuinely holds focus, so the user's typing would flow out of their terminal and into a web form.
  That is a trust failure, not a cosmetic one.

  The two input paths are separable at the guest, which is what makes this fixable: **CDP
  `Input.dispatchKeyEvent` does NOT fire `before-input-event`, while real user input does.** So a
  `before-input-event` arriving while `isAgentDriving(guest.id)` is true is the user's.

  Cite THIS measurement for it, not the earlier `Ctrl+r` A/B: main-side instrumentation, with a
  positive control written at startup so an empty log could not be mistaken for a broken logger,
  recorded ZERO events across a 120-round drive (~3400 dispatched keys), while the user's own
  `Shift` and `Control` presses came through the same handler in the same runs. The `Ctrl+r` A/B
  is unreliable evidence: it ran while the guest held no real focus, so the CDP chord may simply
  never have been delivered, which is indistinguishable from being exempt.

  Main therefore `preventDefault()`s it, encodes it with `encodeTerminalKey`
  (`src/shared/terminal-key-encoding.ts`), and pushes it over `BROWSER_USER_KEY_DURING_DRIVE`; the
  pane routes it to the terminal the user was typing in. Verified end to end: characters typed into
  a driven guest left the page untouched and appeared on the terminal's prompt, and an Enter
  executed the command. Do not "simplify" this to dropping the keystroke - a lost character is
  better than a misdirected one, but neither is the point.

  `encodeTerminalKey` returns null for anything it has no safe mapping for, and null means DROP. A
  wrong byte sequence in a live shell is worse than a missing one, so do not grow that module into a
  general input layer.
- **The restore happens only AFTER the drive ends, never during it.** The steal does surface as a
  trusted `focusout` on the victim, so an early fire is tempting and was the original design.
  Measured: restoring mid-drive breaks the running tool - `kangentic_browser_type` is a click
  followed by char events, and the same call produced an EMPTY input after a restore and the full
  text without one. Do not reintroduce a `focusout` trigger.
- **A user gesture disarms the guard only when it names a DIFFERENT target.** The reported bug is
  "type in the terminal while an agent drives", and a drive is short enough that an actively typing
  user lands a keystroke inside it. That keystroke is a trusted `keydown` on the guarded element -
  the user continuing, not choosing elsewhere. Disarming on it makes the fix fail in exactly its own
  repro, intermittently. `isGestureAwayFromGuardedElement` owns that distinction.
- **An agent-initiated window open is stamped, and stamps deny arrival focus.** An IPC push that
  opens or raises a window passes `agentInitiated` through `setDetailTaskId`, which becomes
  `ManagedWindow.openedByAgent` (transient, never persisted - same shape as `skipEnterAnimation`,
  see [[restore-no-animation-replay]]). `resolveArrivalFocus` then denies EVERYONE, including that
  window's own terminal, while such a window holds window-layer focus. Denying everyone is what
  keeps the tier EXCLUSIVE; an allow-the-others tier degrades back into a race. The tier sits BELOW
  the user claim, because clicking a bottom-panel tab moves no `focusedWindowId` and can legitimately
  claim after an agent open. That is not a promise that a claim always survives an agent open:
  `windowFocusFingerprint()` invalidates a pending claim on ANY window open, so one made just before
  dies at tier 1 regardless.
- **`focusWindow` clears the stamp, and the agent path re-stamps after focusing.** The clear happens
  BEFORE the same-id early return, because an agent-opened window IS the focused one, so the user's
  pointer-down on its frame takes exactly that path. Default-by-omission is "user", so a user path
  can never inherit an agent stamp.
- **Dictation deliberately ignores `openedByAgent`.** `resolveFocusedWindowTerminal` is shared
  between dictation and arrival focus and must stay ONE resolver; the two differ in POLICY.
  Dictation is a later user action and must resolve a target; arrival focus must abstain.
- **No agent-reachable surface autofocuses on mount.** `BrowserEmptyState` can mount from
  `kangentic_browser_open_pane`, so it focuses its URL input only when `focusIsInTypingSurface()` is
  false.
- **A real user gesture is untouched.** A user clicking into the pane still focuses the guest. Focus
  emulation adds a belief; it removes nothing.

## Enforcement (self-maintaining)

- **Test (sites, load-bearing for NEW paths):** `tests/unit/agent-driven-focus-sites.test.ts` scans
  `src/renderer/**` and fails when a file that BOTH subscribes to a main push AND opens a
  task-detail window neither threads the origin nor carries an `// agent-focus-ok: <reason>` marker.
  It additionally pins that the three agent-reachable bridges PASS the origin into the open (checked
  as an argument, not as the identifier appearing somewhere in the file - a presence check passes
  vacuously), that `withGuest` still calls `ensureFocusEmulation` and ends the signal in a `finally`,
  and that nothing under `components/browser/**` autofocuses on mount. It carries a pinned site list
  so a rename cannot silently empty the scan. Writing this scan is what found the Agent Monitor hole
  below.
- **Test (chokepoint, load-bearing):** `tests/unit/browser-pane-driver.test.ts` pins that `withGuest`
  arms `ensureFocusEmulation` (on both the attaching and already-attached paths, and never when the
  gate refuses) and brackets `fn` with the begin/end signal including the throwing path. It also pins
  that the driver never calls `focus()` on the guest at ANY capability tier. These fail the moment
  the chokepoint stops buying the property.
- **Test (visible):** `tests/ui/browser-pane-agent-input-focus.spec.ts` pins that a drive marks the
  pane, un-marks it when the drive ends, says it in words, and never marks a pane whose guest is not
  the one being driven.
- **Test (burst):** `tests/unit/agent-input-burst.test.ts` pins that a run of back-to-back calls
  announces ONE begin, that the end waits for the quiet window, that a call inside that window
  continues the same burst, and that `isAgentDriving` reports true for the WHOLE burst INCLUDING
  the quiet tail. Guarding the tail is deliberate, not an oversight: the pane keeps the guest's
  focus until the burst is announced as over, so gating on the in-flight call alone left exactly
  that window open and 11 of the user's ~62 keystrokes reached the page instead of their terminal.
  Do not narrow it to the in-flight call.
- **Test (CDP payloads):** `tests/unit/browser-input-focus-emulation.test.ts` drives the REAL
  `cdp.ts` through a spying fake debugger and pins that `attachDebugger` alone does NOT enable focus
  emulation (the dev-bridge guard), that `ensureFocusEmulation` sends once per session and re-arms
  after a detach, and the exact mouse/key payloads.
- **Test (policy):** `tests/unit/agent-input-focus-guard.test.ts` pins the three pure decisions, in
  particular that a keystroke into the guarded element does NOT disarm. `terminal-arrival-focus.test.ts`
  pins the `agent-window` tier. TWO of its cases are constructed so the tier below would have
  ALLOWED - the arriving session matches the agent-opened window's, so tier 2 alone returns
  `window` - and those are the ones proving the tier flips the outcome. The other two arrive with a
  mismatched session that tier 2 would have denied anyway, so they pin PRECEDENCE (the reason is
  `agent-window`, not `window-mismatch`) rather than the flip. Both kinds are wanted; just do not
  read the block as four outcome-flipping cases, because `openedByAgent` rides on the same
  `focusedWindowTerminal` object tier 2 consumes, so a mismatched session cannot flip anything.
- **Test (store):** `tests/unit/window-store-agent-open.test.ts` pins default-by-omission, the
  already-focused clear edge, and that the stamp never reaches the persisted workspace.
- **Test (behavior):** `tests/ui/agent-open-pane-focus.spec.ts` drives the real race - focus task A's
  terminal, fire the `open_pane` push for task B, and assert focus never leaves A - plus the
  CONVERSE, that a user opening the same window still focuses its terminal (a "fix" that merely
  stopped arriving terminals from focusing would pass the first and break the app), and that the
  user's click on the agent-opened frame clears the stamp. Verified red-green: removing
  `openedByAgent` from the bridge moves focus to task B.
  `tests/ui/browser-pane-agent-input-focus.spec.ts` covers the guard and the keystroke routing.
- **Test (real guest):** `tests/e2e/browser-popup-window.spec.ts` is the only tier with a live
  `<webview>`, so it is the only place the popup's origin title and shared `Session` can be checked.
- **Review:** `/code-review` flags a new agent-reachable path that focuses, and a new `openWindow`
  call reachable from an IPC push.

**Mechanical coverage is deliberately incomplete in three places, and these are the gaps:**

1. **Agent-vs-user origin of an IPC push is not statically decidable.** `taskDetailOwnership.onOpenHere`
   serves BOTH the user's card click and the agent's open, and no scan can tell which fired. The
   site scan can only demand that the question be ANSWERED - by threading the origin, or by an
   `// agent-focus-ok:` marker where a human made the call. It cannot verify the answer is right.
   **`onOpenHere` has TWO hosts**, the board bridge and `useMonitorDetailOwnership`; the monitor one
   was missed on the first pass and opened its window unstamped, so an agent-opened detail hosted
   there took focus exactly as before the fix. A new host for this push needs the same stamp.
2. **Whether Chromium's focus propagation is suppressed is not unit-testable at all.** No unit tier
   has a live `<webview>` guest, and the UI tier's is an inert stub. The live probe recorded in the
   PR and the preview rig in `docs/embedded-browser.md` are the only evidence, and an Electron major
   bump can silently change the answer. **Re-run the probe on an Electron upgrade.**
3. **A future CDP input primitive invoked outside a `withGuest` body** is outside the guarantee.
   [[browser-automation-driver]]'s "every driving tool routes through `withGuest`" is what keeps that
   closed, and it is enforced by review, not by type.

## Scope

Agent-driven focus across the main/renderer boundary: the shipped CDP driver and browser-pane
driver, the `kangentic_browser_*` tools, the Browser pane and its empty state, and the
window-manager paths an agent can reach. Does not govern arrival ordering AMONG terminals
([[terminal-arrival-focus]]), the dev-only `kangentic_devtools_*` bridge (which drives Kangentic
itself and is expected to move focus), or a user's own click into a pane.
