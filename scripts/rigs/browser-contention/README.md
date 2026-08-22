# Browser-contention rig

Reproduces the task-#8 shape end to end: **three concurrent, indistinguishable
callers driving one Browser pane**.

That original report was three `general-purpose` subagents interleaving
navigations, clicks and screenshots on a single pane, each believing it had
exclusive control, with nothing logged. The property that made it possible is
that subagents inherit the parent's `mcp.json` verbatim, so every one of them
dials the same `/mcp/<projectId>/<callerSessionId>` and is indistinguishable at
the transport.

This rig recreates exactly that: N HTTP clients on ONE session id, firing
concurrently at the real product MCP server in a live preview.

**No agent is spawned and no quota is spent.** The session the callers present
is held open by a mock TUI (`mock-tui.js`) whose only job is to exist in the
session registry so caller resolution behaves as it does for a real agent.

## Running it

```
node scripts/worktree-preview.js          # a preview must be running
node scripts/rigs/browser-contention/rig.mjs
node scripts/rigs/browser-contention/rig.mjs --keep    # leave state behind
```

The rig creates its own task, reserves its own port through
`kangentic_reserve_dev_ports` (so the port feature dogfoods itself), serves its
own page on it, and cleans all of it up on exit.

## Two entry points

`rig.mjs` covers concurrent contention. `handoff.mjs` covers #542 - the user
closing a task-detail window while an agent is driving its pane - and is
SEPARATE on purpose: it asserts on the implicit-target path an agent actually
uses, and that path refuses with `multiple-panes` when several panes match the
task, so leftover lanes from the contention scenarios would make its result
unreadable. Run it against a preview that has none.

```
node scripts/rigs/browser-contention/handoff.mjs
```

It opens a real pane, confirms the agent can drive it, clicks the task-detail
close control, and then requires all four of: the user's pane is gone, a
hand-off lane took over, **the same caller can still drive**, and the hand-off
is logged.

## What it asserts

| | |
|---|---|
| **A1** | Three concurrent callers on ONE shared guest (a lane) |
| **A2** | The same, on a real task-detail pane |
| **B** | Three concurrent callers, one isolated lane each |
| **C** | The lane cap refuses the N+1th with an actionable error |
| **D** | Contention is visible: per-drive telemetry and a CONTENTION warning |

A1 and A2 make **two** assertions, and the completeness one is not optional.
Each caller types a long run of one distinct character; the rig then reads an
append-only keystroke log from the page (not the input's value - see below) and
requires that *every* caller's characters arrived AND that each caller's run is
contiguous.

## Two traps this rig already fell into

Both were found by running it, and both are the reason the assertions look the
way they do.

**1. Contiguity alone passes when the fix is removed.** With the per-guest FIFO
disabled, the damage is not shredding, it is LOSS: three concurrent click+type
sequences race for focus and only one caller's characters reach the page at all
(40 of 120). A contiguity check passes on that vacuously, because a single
surviving run is trivially contiguous. An assertion that the fix's removal
satisfies is not an assertion. Hence the length check first.

**2. The input's `value` is the wrong observable.** `kangentic_browser_type`
focuses by clicking the element's CENTRE, and once the field has text the centre
is mid-text, so a later caller's caret lands inside an earlier run and the value
shows a split that never happened at dispatch. That is a property of clicking to
focus, not of the lock. The page therefore keeps an append-only `keydown` log,
which records dispatch order. It is also a text node, so `query_dom` can read it
without `eval` - which is off by default in Agent Browser settings and should
stay off for this to mean anything.

## Verified red-green

Measured by disabling `withGuestDriveLock` and restarting the preview:

| | shared lane | real pane |
|---|---|---|
| FIFO disabled | **40/120 chars, 1 of 3 callers** | **40/120 chars, 1 of 3 callers** |
| FIFO restored | 120/120, 3 contiguous runs | 120/120, 3 contiguous runs |

A rig that has never been seen to fail proves nothing. Re-run that check if the
locking changes.

## Why this is not a test tier

It needs a live `/preview` and a real MCP server over HTTP, so it cannot ride
unit, UI, or E2E. It is a manual rig, run when the browser-automation or
dev-port subsystems change.

## Two traps in `handoff.mjs` too

The task-detail close control is found by `data-testid="task-detail-close"`,
never by title: the OS window's close button is ALSO titled "Close", and
clicking that one quits the app - which is what happened on the first attempt.

And the first `open_pane` on a cold preview can exceed the tool's own 10s bound
while the window and its webview mount, so it retries once. A cold-start
timeout there is not a failure of the pane path.

## Known environment limit

A2 skips when the preview window is occluded. An occluded window reports
`document.visibilityState === 'hidden'`, which stalls `requestAnimationFrame`
completely, so the pane's `<webview>` never constructs and `open_pane` times
out. Bring the preview window to the front for A2. A1 covers the same FIFO on
the same chokepoint (`withGuest` keys the lock on `webContentsId`, and a lane
and a pane queue through it identically), so a skipped A2 is a coverage
reduction, not a gap.
