## What's New

- Browser tools that act on one element by selector now refuse an ambiguous match. When a selector hits more than one visible element, the agent gets back up to five candidates, each with a unique selector to retry with, instead of acting on the first match. Pass `strict: false` for the old behavior. A coordinate click with no coordinate space also returns a note on mapping screenshot pixels.
- The Workflows canvas moved to React Flow 13. Dragging a card is smoother, and the canvas keeps the app's background under a dark or light OS theme.

## Bug Fixes

- Kangentic no longer rewrites a `kangentic.json` written by a newer build. An older build used to strip guards it could not read and save the stripped file back, which left Move to column automations running with no condition. It now applies what it can read, keeps a column's current automations when a guard is unreadable, and says so on the board.
- Resuming a paused task, or restarting from Settings, now runs the column's own agent instead of the project default.
- View conversation opens a paused task's transcript after a restart, instead of showing "(unknown task)".
- On Windows, the Knowledge Graph embedder now ships the Visual C++ runtime it needs, so it loads on a machine that lacks one.
- On a Linux machine with no GPU, terminals go straight to software rendering instead of retrying WebGL all session.
- On Windows, a long prompt to an agent launched through a `.cmd` shim is refused up front with a clear reason, instead of showing a working agent that never started. A pnpm shim to a native executable now starts directly.
- On the Workflows canvas, releasing a card drag, a pan or a link drag over a disabled toolbar button now ends the gesture. The card no longer sticks to the pointer.
- On Windows, removing a worktree finds the processes holding it again when another process's command line contains a control character.
