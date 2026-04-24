## What's New

- **Auto-Resume Agents on Restart toggle** in Behavior settings. Decide whether projects should resume previously-running agent sessions on open, or wait for you to click Resume on each task. Useful when resuming many agents at once slows your machine.
- **Cross-project MCP tool calls.** Pass an optional `project` parameter to most MCP tools to query or mutate other projects without switching context. A new `kangentic_list_projects` tool helps agents discover available projects.

## Bug Fixes

- Tasks unarchived from Done no longer snap back to the Done column momentarily before settling.
- Sessions stay properly suspended on project open when Auto-Resume is disabled, instead of being silently resumed.
- Agent CLI detection now finds Claude/Codex installs on macOS and Linux when Kangentic is launched from the GUI (not just the terminal).
- Brief `cmd.exe` console windows no longer flash on Windows during agent version probes.
- Task cards no longer get stuck on a stale "thinking" indicator when the activity cache is missing.
- A failed agent spawn now reverts the task back to its source column instead of leaving it stranded mid-move.
