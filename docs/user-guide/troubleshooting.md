---
type: Guide
title: Troubleshooting
description: "The window vanishing with no crash dialog when the Chromium graphics process fails: Kangentic turns off Graphics acceleration, and gpu-process-gone crash records say what happened."
tags: [troubleshooting, gpu]
sources:
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
