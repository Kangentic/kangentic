---
description: Open dev server for previewing live code changes
allowed-tools: Bash(node:*), Bash(npm:*)
argument-hint: [--fresh]
---

# Preview

Open a new terminal window running a Kangentic dev server for previewing live code changes in the current worktree.

## Instructions

1. If the user passed `--fresh` (e.g. `/preview --fresh`), run `node scripts/worktree-preview.js --fresh`. Otherwise run `node scripts/worktree-preview.js`.
2. Report the output — it will show the assigned port and directory.
3. If the command fails, report the error message.

## Notes

- This script must be run from inside a `.kangentic/worktrees/` directory. It will error with a clear message if run from the project root.
- Creates a filesystem junction (Windows) or symlink (Unix) from `<worktree>/node_modules` → `<root>/node_modules` — no `npm install` or rebuild needed.
- The preview instance runs on a dynamically assigned port (starting from 5174) so it does not conflict with the root dev server on 5173.
- Each preview instance has its own empty board — board state does NOT sync between instances. Use the root instance for task management.
- When the preview terminal is closed, the worktree's `.kangentic/` and `.vite/` directories are automatically cleaned up (ephemeral mode). The node_modules junction is left in place for instant restarts.
- Multiple `/preview` invocations can run simultaneously — each gets its own port.
- Pass `--fresh` to launch without auto-opening a project (shows the Welcome Screen). Useful for testing the first-launch experience. Example: `/preview --fresh`
- **Stopping a preview (restarts):** run `node scripts/worktree-preview.js --stop --port=<port>` instead of `taskkill`. It writes a stop file that dev.js watches, so the server cleans up and exits 0 and its terminal tab closes itself; a `taskkill /F` exits non-zero and leaves a dead "[process exited with code 1]" tab behind on every restart. `--stop` falls back to a force kill automatically if the server does not exit within 10s (e.g. an instance launched from a checkout predating the stop-file watcher). Omitting `--port` stops every preview this worktree is running.

## Allowed Tools

Only use `Bash` (for the `node` command). Run from the current working directory — do not chain commands.
