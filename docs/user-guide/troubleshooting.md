---
type: Guide
title: Troubleshooting
description: "Two failures after install: the window vanishing with no crash dialog when the Chromium graphics process fails (Kangentic turns off Graphics acceleration, gpu-process-gone crash records), and the Windows Low on memory warning (commit limit, page file size, Max Concurrent Sessions)."
tags: [troubleshooting, gpu, memory, windows]
sources:
  - resource: src/main/diagnostics/host-memory.ts
  - resource: src/main/diagnostics/crash-capture.ts
---
# Troubleshooting

## Graphics failures

Chromium renders the app through a separate graphics process. Rarely, that process fails over and
over, or cannot be started again. When it
exhausts every fallback it has, Chromium shuts the whole app down on purpose. There is no crash
dialog and no warning: the window simply disappears. On some machines it happens within seconds of
launching, so the app can look like it will not start at all. On others, so far only Linux, it
happens a few minutes into a normal session.

Kangentic recovers itself. The next launch starts without graphics acceleration, which removes the
graphics process entirely and takes that shutdown off the table. You get a toast saying so, and
Settings > Performance shows **Graphics acceleration** switched off, with a note that Kangentic
turned it off after repeated failures.

What to expect while it is off:

- Terminals render through the slower DOM path instead of WebGL. Long-running agents with heavy
  output feel less smooth. Everything still works.
- Animations and the rest of the UI are unaffected.
- Nothing turns it back on by itself. When you want to try again, switch **Graphics acceleration**
  back on in Settings > Performance and choose **Restart now**. Kangentic restarts with acceleration
  on, and running agents resume after the restart. If the failure returns, the next launch turns it
  off again.

Only a graphics process that actually fails counts. Shutting down or restarting the computer with
Kangentic open, ending it from Task Manager, or running out of memory does not turn acceleration off.

Kangentic does not diagnose the cause, and deliberately does not guess at one. On the installs that
failed at boot, the failures started seconds in, before any agent or terminal existed. A display
driver is the usual culprit for that shape, so updating yours is the first thing worth trying, but
the app has no way to confirm that from the inside and will not claim it did. If it keeps happening,
the local crash records under `<project>/.kangentic/logs/crashes/` (kind `gpu-process-gone`) are the
useful thing to attach to a bug report. A record whose message ends in "(not a GPU fault)" was a kill
or a shutdown, not a failure. When the graphics process could not be started at all,
there is no such record: Chromium never reports a failed start to the app, and only the fallback
itself is recorded.

Unrelated, despite the similar name: **Model acceleration** in Settings > Knowledge Graph controls where
the local search model runs, not app rendering. The two are independent.

## Low memory warning (Windows)

Windows keeps a second memory budget besides RAM: commit, the memory programs have reserved. Every
reservation counts against a limit of your RAM plus the page file, whether or not the program has
used it yet. Kangentic checks the room left under that limit once a minute and warns when less than
2 GB is left. On a machine whose limit is under 40 GB, the line is 5% of the limit instead. Task
Manager's Memory percentage is RAM, so it can read half free while the warning is up. The figure to
watch is Committed, under Performance > Memory. macOS and Linux report no commit figure, so the
warning never shows there.

Windows does not stop a program when the limit is reached. The next program that asks for memory is
refused, and it usually crashes. That can be an agent, a dev server, or Kangentic itself.

Where the reservations go, measured on Windows 11 with Claude Code 2.1.306:

- Each Claude Code agent reserves about 1 GB, nearly all of it the `claude` process. The MCP servers
  you configured start once per agent on top of that. A server launched through `npx -y` also keeps
  an `npx` process of about 110 MB beside each agent.
- Kangentic itself reserves about 3 GB, most of it the dictation and Knowledge Graph models when
  those features are on.
- Builds, test runs, dev servers and browsers that agents start come on top. One of them can reserve
  several GB, and they are what usually tips a busy machine over.

Two changes give agents more room:

- **Give the page file a larger starting size.** A page file Windows manages grows as commit nears
  the limit, but a burst of reservations can outrun the growth. Open System Properties > Advanced >
  Performance Settings > Advanced > Virtual memory > Change, clear "Automatically manage paging file
  size", and choose Custom size. Set the Initial size so the limit sits at least 8 GB above the
  Committed figure you see with your usual agents running, and the Maximum size no lower than that.
- **Run fewer agents at once.** Lower Max Concurrent Sessions in Settings > Behavior, which the
  warning's Settings button opens. Requests past the limit wait in the [Session Queue](sessions-and-worktrees.md#session-queue).

For an MCP server launched through `npx`, install the package once and point its MCP config at the
installed command, so no `npx` process sits beside each agent.

The warning reads "Low on memory" over how much room is left, shows how long ago the reading was
taken, and clears by itself once the room climbs back past twice the line. When Kangentic is also
pausing idle agents for you, see [Pausing agents](sessions-and-worktrees.md#pausing-agents).
