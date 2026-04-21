## What's New

- MCP server now exposes update and delete tools for backlog items, so agents can curate the backlog directly.
- Faster task detail terminal: resize and scrollback now load in parallel on mount.
- Activity log is virtualized, so large activity histories render smoothly.
- Board and terminal input pipeline trimmed: per-task lifecycle locks hold for less time, and xterm input is batched into a single IPC write per microtask.
- Backlog dialogs load as sibling components for snappier backlog interactions.

## Bug Fixes

- Restored the generous git timeout ceiling so heavy repos can clone and update worktrees without spurious timeouts.
- Fixed a Windows-only asar handle leak that prevented worktree cleanup.
- Done-task worktree cleanups that failed on close now retry the next time the project opens.
