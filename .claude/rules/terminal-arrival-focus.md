---
paths:
  - "src/renderer/**"
---
# Rule: an arriving terminal never decides its own focus

A terminal "arrives" when it finishes mounting or replaying: the deferred-init `focus()`, the
mount-time scrollback replay, and any reload the caller did not opt out of. Several terminals can
arrive within a few frames of each other, and their finish order is not knowable in advance:
opening a task detail claims that task's session, which evicts the bottom panel's selection and
makes it mount a terminal for a DIFFERENT session at the same moment; each then fetches
scrollback, which main deliberately delays 150-400ms while the agent TUI's repaint settles.

When every one of those paths ended in an unconditional `xterm.focus()`, whichever replay resolved
last won. The user opened a task, started typing, and the keystrokes went to whatever agent the
panel had fallen back to (the reported case typed `/compact` into the wrong session). It presented
as intermittent, which was the mechanism, not flakiness. The same grab also silently re-pointed the
dictation target, since `noteTerminalFocus` is wired to the textarea's `focus` event and cannot
tell a programmatic focus from a user one.

## The rule

**Arrival focus is decided by user-intent state, never by replay order or rAF order.** Route every
programmatic focus on an arriving terminal through `mayTakeArrivalFocus(sessionId)`
(`src/renderer/utils/terminal-arrival-focus.ts`). Hosts own the policy and pass it to `useTerminal`
as the `mayTakeArrivalFocus` option, so the hook stays surface-agnostic.

- **Tiers are EXCLUSIVE.** A tier that resolves an answer decides: it allows a match and DENIES a
  mismatch. It never falls through to a lower tier that might allow. A falling-through tier
  degrades straight back into a race, because two terminals arriving in the same frame would both
  find themselves permitted.
- **Do not gate on `document.activeElement` alone.** Both terminals arrive with focus in the same
  place, so an "is focus orphaned" test just converts "last replay wins" into "first rAF wins", and
  it blocks the detail terminal outright whenever the clicked board card kept focus.
- **A gesture that names a terminal which has not mounted yet must claim it**
  (`claimArrivalFocus`). The bottom panel is not a window, so clicking its tab or expanding it
  moves no layer's `focusedWindowId` and tier 2 would otherwise deny it forever.
- **Genuinely user-initiated focus stays unconditional** and must NOT be routed through the
  arbiter: pointer-down on a window frame, a file drop on a terminal, the maximize/restore
  re-homing, and the imperative `focus()` those use.
- **Do not reuse the word "focused" for this.** `focused-terminals.ts` already owns it for the
  PTY-stream focused SET (which sessions main forwards bytes for). This is keyboard focus, and
  exactly one terminal holds it.

## Enforcement (self-maintaining)

- **Test (sites):** `tests/unit/terminal-arrival-focus-sites.test.ts` scans the terminal-host files
  under `src/renderer/**` (those that call `useTerminal(` or reference `.xterm-helper-textarea`)
  and fails on any focus call that is neither guarded by `mayTakeArrivalFocus` nor carries an
  `// arrival-focus-ok: <reason>` marker. It matches bare `focus()` as well as `.focus()`, because
  three of the real sites call a destructured `focus` with no receiver and a `\.focus\(\)` pattern
  would skip exactly the sites the rule exists to protect. Runs in CI via `npm run test:unit`.
- **Test (policy):** `tests/unit/terminal-arrival-focus.test.ts` pins the tier order and, in
  particular, that a `claim-mismatch` and a `window-mismatch` both DENY rather than fall through.
  Every mismatch case is constructed so the next tier down would have allowed it.
- **Test (behavior):** `tests/ui/terminal-arrival-focus.spec.ts` drives the real race with a
  per-session replay delay and asserts focus stays in the just-opened detail, plus that a panel tab
  click still focuses its own terminal.
- **Review:** `/code-review` flags a new arrival path that focuses unconditionally.

**Mechanical coverage is deliberately incomplete on the CLAIM side, and this is the gap:** the
site scan can see a focus call that is not arbitrated, but it cannot see a user gesture that
SHOULD have claimed and did not - that requires knowing the gesture names a terminal which has not
mounted yet, which is not statically expressible. A new panel-side gesture that skips
`claimArrivalFocus` therefore fails no unit test; its terminal simply mounts unfocused whenever a
window holds window-layer focus. The behavior spec's second and third tests are the only guard, so
extend them when a new claiming gesture is added.

## Scope

Programmatic focus on terminals under `src/renderer/`. Does not govern focus inside a terminal's
own input handling, non-terminal focus (dialogs, form fields, menus), or the PTY-stream focused set
in `focused-terminals.ts` / `focused-sessions.ts`, which is a different mechanism with a
confusingly similar name.

A focus move an AGENT causes is governed by [[agent-driven-focus]], which spans main and renderer
and adds the exclusive `agent-window` tier to `resolveArrivalFocus`. This rule decides which
terminal wins among ARRIVING terminals; that one decides whether an agent may move focus at all -
and, for the one case it cannot prevent (a click into a Browser pane focuses the guest, exactly as a
user's click would), how that move is bounded, shown, and handed back.
