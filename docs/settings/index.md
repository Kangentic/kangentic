# Settings

## How settings resolve

* [Configuration cascade](cascade.md) - How a setting resolves from DEFAULT_CONFIG through the global config.json to the project .kangentic/config.json override, which keys are app-only or per-project, how a failed config write is reported, swimlane override fields, column automation types, permission mode order, and config IPC channels.
* [Settings panel](settings-panel.md) - Layout of the Settings panel: project and system tab groups and the three system tiers, why a tab must match where its setting persists, what the Task, Performance and Terminal tabs hold and why, where each project tab saves, multi-token search, and how the Hotkeys tab captures and conflict-checks rebinds.

## Key reference

* [App config keys](app-config.md) - Every AppConfig key with its type and default, from theme, card, diff and window layout through terminal, notifications, context bar and browser settings to agent CLI paths, session limits, remote execution, git worktree and PR refresh, the MCP server, dev ports and mobile relay.

## Board files

* [Board config files](board-config.md) - How kangentic.json and kangentic.local.json define the shared board, which way each sync runs, how a hand edit ghosts or deletes a column, the file schema with its onEnter, onTurnEnd and onExit arrays, which bad rows are skipped, and where Shortcuts and Board Profiles are stored.
