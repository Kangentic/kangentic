## Bug Fixes

- Error reports sent to Sentry no longer carry breadcrumbs holding your file paths, agent command lines, task titles, column prompts, or branch names. Both the main process and the renderer now drop or redact each breadcrumb before it leaves the app.
- On macOS, a program an agent starts from a terminal no longer hands its crashes to Kangentic's crash reporter, and neither do the login-shell probe, shortcuts, run-script automations, or the worktree init script. Those crashes used to arrive as Kangentic crashes. A crash from another program that still reaches the crash database is now one grouped warning, with that program's memory dump removed.
- The pull request pill now settles within about 30 seconds of a PR's checks finishing, instead of waiting for the five-minute refresh. A required check that has not started yet reads as queued rather than blocked.
- An agent's key presses in the Browser pane could land in your terminal when the pane did not have focus, so an Escape meant for a web page could interrupt the agent that sent it. The pane now refuses keys it would not receive. Typed text also no longer doubles characters in a terminal or drops a trailing Enter.
- With animations turned off, a dialog, panel, or popover could occasionally stay open and ignore Escape, the close button, and backdrop clicks. It now always closes.
- On Linux, a GPU process that fails to launch now leaves a record behind, so the next launch switches to software rendering instead of hitting the same crash.
- In the web demo, Escape now closes an open task window and then leaves the demo, instead of doing nothing while the pointer rests over the task's terminal.
