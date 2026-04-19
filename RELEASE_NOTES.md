## What's New

### Three New Agent Adapters
- **Cursor CLI** - including stream-json init parsing so the agent name and model show up immediately.
- **GitHub Copilot CLI** - full MCP config integration.
- **Warp CLI (Oz)** - newly renamed and polished.

### Asana Board Integration
- Import issues and comments from Asana with an OAuth PKCE setup wizard.
- PAT authentication available for attachment-heavy imports.
- Attachments are now captured during import.

### Reimagined Project Sidebar
- New layout with project counts in the header and group rows.
- Per-project idle and active task counts at a glance.
- Polished UX throughout.

### Command Bar Upgrades
- Ctrl+Shift+P now shows the full ContextBar in a responsive overlay, not just the prompt.

### Board Improvements
- **Done column redesign:** reclaims worktrees on archive while preserving session resumability, with a clearer move-to-Done confirmation flow.
- **Worktree base-branch encoding:** auto-generated worktree names include the base branch, and the task UI surfaces it so you can see what each branch forked from.

### Agent Quality
- **Aider:** session history parsing, transcript cleanup, and mode-aware idle detection.
- **Background shell detection:** activity tracking distinguishes user-driven work from background shells to prevent false idle states.

## Bug Fixes

- Startup no longer blocks session recovery on resource cleanup - the app opens faster.
- Bulk task delete no longer freezes the UI or orphans worktrees when git operations hang.
- Board archive is now atomic when moving tasks to Done.
- Task move to To Do correctly clears spawn progress.
- Cursor and Copilot agents no longer get stuck at "Loading agent...".
- Cursor spinner now clears in interactive TUI mode.
- macOS auto-updater no longer fails on transient errors.
- Dates now render in the user's system locale.
- Completed tasks no longer stick in the Done dropzone.
- Context bar pills distribute overlay row space evenly.
- Various PTY and shutdown stability fixes.
