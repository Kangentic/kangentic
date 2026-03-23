## What's New
- **MCP Server for agents** - Claude Code agents can now create tasks, search the board, view statistics, and more through structured MCP tool calls during their work. Enabled by default, configurable per-project in Settings > MCP Server.
- **Copy Image from attachments** - right-click any image attachment thumbnail to copy it to your clipboard
- **Sidebar project actions** - selected projects now show action buttons (Open, Settings, Delete) directly on the row, plus a right-click context menu with Rename, Open in Explorer, and more

## Bug Fixes
- Fixed F12 and Ctrl+Shift+I DevTools shortcuts not working in dev mode
- Fixed sessions showing as "running" in the database when they were actually queued
- Fixed PowerShell prompts hanging when task descriptions contained backticks or dollar signs
- Fixed worktree cleanup failures on Windows due to node_modules junction removal ordering
- Fixed native modules not rebuilding automatically after npm install
- Fixed stale worktree resources not being cleaned up for backlog tasks on startup
- Fixed race condition in trust manager writes during concurrent agent spawns
- Fixed Ctrl+C/Ctrl+V not working for copy/paste in the terminal
- Fixed git lock contention when multiple tasks are dragged simultaneously
- Fixed duplicate terminal history appearing when switching between panel and dialog views
- Fixed task moves not being reverted when a duplicate branch name is detected
- Fixed user-paused sessions losing their paused state across app restarts
- Fixed "Starting agent..." getting stuck when queue promotes a session with a mismatched ID
