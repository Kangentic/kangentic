---
description: Open dev server for previewing live code changes
allowed-tools: Bash(node:*), Bash(npm:*)
argument-hint: [--fresh] [--no-watch]
---

# Preview

Open a new terminal window running a Kangentic dev server for previewing live code changes in the current worktree.

## Instructions

1. If the user passed `--fresh` (e.g. `/preview --fresh`), run `node scripts/worktree-preview.js --fresh`. Otherwise run `node scripts/worktree-preview.js`.
2. Report the output - it will show the assigned port, PID, and a `Watch:` command.
3. If the command fails, report the error message and stop.
4. Unless the user passed `--no-watch`, or the launcher reported `PID: unknown` (the watcher cannot attach without a live PID file and would exit `1` immediately), run the printed `Watch:` command (`node scripts/worktree-preview.js --wait --port=<port>`) as a **separate Bash call with `run_in_background: true`**. Do not poll it, do not wrap it in a `Monitor`, and do not schedule a `ScheduleWakeup` fallback - it blocks until the preview exits, and the harness delivers a `<task-notification>` with its exit code on its own.
5. When that notification arrives, tell the user what happened and stop offering a `--stop` command for that port:
   - exit `0` - exited cleanly (user closed the terminal, or a `--stop` you or the user ran)
   - exit `2` - crashed; point the user at the preview terminal's scrollback
   - exit `3` - force-killed or the terminal was hard-closed
   - exit `1` - the watcher couldn't attach (unlikely right after a successful launch)

## Notes

- This script must be run from inside a `.kangentic/worktrees/` directory. It will error with a clear message if run from the project root.
- Creates a filesystem junction (Windows) or symlink (Unix) from `<worktree>/node_modules` → `<root>/node_modules` — no `npm install` or rebuild needed.
- The preview instance runs on a dynamically assigned port (starting from 5174) so it does not conflict with the root dev server on 5173.
- Each preview instance has its own empty board — board state does NOT sync between instances. Use the root instance for task management.
- When the preview terminal is closed, the worktree's `.kangentic/` and `.vite/` directories are automatically cleaned up (ephemeral mode). The node_modules junction is left in place for instant restarts.
- Multiple `/preview` invocations can run simultaneously - each gets its own port, and each gets its own watcher.
- Pass `--fresh` to launch without auto-opening a project (shows the Welcome Screen). Useful for testing the first-launch experience. Example: `/preview --fresh`
- **Stopping a preview (restarts):** run `node scripts/worktree-preview.js --stop --port=<port>` instead of `taskkill`. It writes a stop file that dev.js watches, so the server cleans up and exits 0 and its terminal tab closes itself; a `taskkill /F` exits non-zero and leaves a dead "[process exited with code 1]" tab behind on every restart. `--stop` falls back to a force kill automatically if the server does not exit within 10s (e.g. an instance launched from a checkout predating the stop-file watcher). Omitting `--port` stops every preview this worktree is running.
- **Watching only observes.** It never stops or restarts the preview - do not run `/preview` again automatically just because a watcher fired.
- A notification arriving immediately after you ran `--stop` yourself is the expected confirmation of that stop, not a new event to alarm the user about.
- The watcher holds a background task slot for the preview's whole lifetime, which can be hours. Pass `--no-watch` to skip it and launch fire-and-forget as before.
- If the Claude Code session restarts, a pending watch notification is lost - the preview keeps running regardless. Re-attach with `node scripts/worktree-preview.js --wait --port=<port>` if you need to know when it later exits.

## Allowed Tools

Only use `Bash` (for the `node` command). Run from the current working directory — do not chain commands.
