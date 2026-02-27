# Preview

Open a new terminal window running a Kangentic dev server for previewing live code changes in the current worktree.

## Instructions

1. Run `node scripts/worktree-preview.js` from the current working directory.
2. Report the output — it will show the assigned port and directory.
3. If the command fails, report the error message.

## Notes

- This script must be run from inside a `.kangentic/worktrees/` directory. It will error with a clear message if run from the project root.
- Creates a filesystem junction (Windows) or symlink (Unix) from `<worktree>/node_modules` → `<root>/node_modules` — no `npm install` or rebuild needed.
- The preview instance runs on a dynamically assigned port (starting from 5174) so it does not conflict with the root dev server on 5173.
- Each preview instance has its own empty board — board state does NOT sync between instances. Use the root instance for task management.
- When the preview terminal is closed, the worktree's `.kangentic/` and `.vite/` directories are automatically cleaned up (ephemeral mode). The node_modules junction is left in place for instant restarts.
- Multiple `/preview` invocations can run simultaneously — each gets its own port.

## Allowed Tools

Only use `Bash` (for the `node` command). Run from the current working directory — do not chain commands.
