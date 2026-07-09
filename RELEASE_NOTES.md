## What's New

- **Conversation viewer upgrades** - long transcripts now scroll smoothly, with in-viewer search and open-at-position so you can jump straight to the turn you care about.
- **Per-project agent defaults** - set a default model and reasoning effort per project, override the model, effort, and permission mode per task, and configure MCP servers from agent settings.
- **Repo history in the Changes panel** - browse the commit history, view any file's history, and run blame without leaving the task.
- **Move a task to another project** - relocate a task across projects, also available to agents via the kangentic_move_task_to_project MCP tool.

## Bug Fixes

- Fixed a false "idle" state while an agent was retrying after a transient server error.
- Fixed an input and focus freeze at a fullscreen TUI select prompt.
- Made copy and select-all reliable in the diff viewer.
- Removed a redundant PR pill from the task detail header.
- Untangled the Hotkeys and Shortcuts terminology in settings.
