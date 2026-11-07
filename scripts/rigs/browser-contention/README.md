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

## Four entry points

`rig.mjs` covers concurrent contention. `handoff.mjs` covers #542 and the parking
that followed it - the user closing a task-detail window while an agent is
driving its pane, then the guest really dying - and is SEPARATE on purpose: it asserts on the implicit-target path an agent actually
uses, and that path refuses with `multiple-panes` when several panes match the
task, so leftover lanes from the contention scenarios would make its result
unreadable. Run it against a preview that has none.

```
node scripts/rigs/browser-contention/handoff.mjs
```

It opens a pane and requires that no window appeared, opens the window as a user
does and confirms the agent can drive it, clicks the task-detail close control,
and then requires that the window parked with the same pane and handle and **the
same caller can still drive**. It then destroys the guest and requires that a
hand-off lane took over, the caller can still drive, and the hand-off is logged.

`lifecycle.mjs` covers the lane-cleanup guarantee (#F): does a lane die with the
session that owns it? Also SEPARATE, and for a sharper reason - it is the one
probe that must spawn through the BOARD rather than `sessions.spawn`.

```
node scripts/rigs/browser-contention/lifecycle.mjs
```

A lane cannot be asked for: `open_pane` mounts a pane whenever the project is open,
parked if no window is. So these rigs get one the way the product does, by
destroying a live guest (`dropTaskWindow` in `lib.mjs`).

Keep at most 8 mock agents alive, the project's default session cap. With a ninth
alive, its pane never mounted and `open_pane` answered `pane-open-timeout`, and the
same loop passed once each round killed its agent. A pane mounts only on a terminal
surface, which fits a queued session, though nobody read the session's status.

`idle-reclaim.mjs` covers the other half of that guarantee: the 30-minute idle
sweep must reap a lane nobody is using WITHOUT reaping one that is. It is
separate because it is the only probe that has to control the clock, and because
a sweep only ever finds another task's lane, so it runs three agents: one lane
left idle, one kept warm, and one more that opens last and runs the sweep.

Edit `LANE_IDLE_RECLAIM_MS` in `browser-lane-manager.ts` to match the window and
restart the preview, then set the window with the `IDLE_MS` environment variable.
It defaults to 15000. In PowerShell that is two statements, so set it first:

```
$env:IDLE_MS = 15000
```

```
node scripts/rigs/browser-contention/idle-reclaim.mjs
```

## The trap that made this probe lie

Its first version used the raw `SESSION_SPAWN` passthrough with a mock command,
the way `rig.mjs` does, and reported three leaked lanes. That was the RIG's bug.

The raw passthrough creates a registry session with **no row in the `sessions`
table**. `markRecordExited` resolves its record through
`sessionRepo.findByAnyId`, so with no row there is no record, the CAS never
runs, and `destroyLanesForSession` is never reached. `spawn-entry-point-parity.md`
says exactly this: the raw passthrough is allowlisted as NOT a task-agent spawn.

A real agent always has a record. So `lifecycle.mjs` points the claude CLI at
`tests/fixtures/mock-claude.cmd` (zero quota) and moves a task into a spawning
column - the production entry point, which does create one. Verified red-green
by removing the `destroyLanesForSession` call: the lanes survive without it, and
none does with it.

The lesson generalises: a rig that takes a shortcut around the production entry
point can report a failure the product does not have, and that is just as
expensive as missing one it does.

## What it asserts

| | |
|---|---|
| **A1** | Three concurrent callers on a parked pane, with no window open |
| **A2** | The same, with the task window open |
| **A3** | The same, on the offscreen lane a dead guest leaves |
| **D** | Contention is visible: per-drive telemetry and a CONTENTION warning |

A task has one surface, so these are that surface in each form it takes. Each A
scenario makes **two** assertions, and the completeness one is not optional.
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

| | lane | pane |
|---|---|---|
| FIFO disabled | **40/120 chars, 1 of 3 callers** | **40/120 chars, 1 of 3 callers** |
| FIFO restored | 120/120, 3 contiguous runs | 120/120, 3 contiguous runs |

A rig that has never been seen to fail proves nothing. Re-run that check if the
locking changes.

## Why this is not a test tier

It needs a live `/preview` and a real MCP server over HTTP, so it cannot ride
unit, UI, or E2E. It is a manual rig, run when the browser-automation or
dev-port subsystems change.

## A trap in `handoff.mjs` too

The task-detail close control is found by `data-testid="task-detail-close"`,
never by title: the OS window's close button is ALSO titled "Close", and
clicking that one quits the app - which is what happened on the first attempt.

The first `open_pane` on a cold preview can exceed the tool's own 10s bound while
the webview mounts, so it retries once. A cold-start timeout there is not a
failure of the pane path.
