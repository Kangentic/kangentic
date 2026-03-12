# Configuration Reference

## Configuration Cascade

Kangentic uses a three-tier config resolution:

1. **Global defaults** (`DEFAULT_CONFIG` in `src/shared/types.ts`)
2. **Global user config** (`<configDir>/config.json`)
3. **Project overrides** (`<project>/.kangentic/config.json`)

Effective config = deep-merge(global defaults, user config, project overrides).

The config directory (`<configDir>`) is platform-specific:

- **Windows:** `%APPDATA%/kangentic/`
- **macOS:** `~/Library/Application Support/kangentic/`
- **Linux:** `~/.config/kangentic/`

## Settings Panels

Both panels use a VS Code-style layout: a sidebar with tab navigation on the left and the active settings pane on the right. A search bar at the top filters settings by keyword. Search uses multi-token matching (all tokens must appear in the setting name or description). Results are grouped by tab with match count badges on the sidebar; tabs with zero matches are dimmed. Press Ctrl+F (Cmd+F on macOS) to focus the search bar, Escape to clear the filter.

- **App Settings** -- opened via the titlebar gear icon (labeled "Global"). Contains two scope tabs at the top: **Global** (app-wide defaults) and **Project** (per-project overrides for the active project). Sidebar tabs: Appearance, Terminal, Agent, Git, Behavior, Notifications, Privacy. The first four tabs (above the separator) are project-overridable and appear in both scopes. The last three (Behavior, Notifications, Privacy) are global-only. Changes save immediately. Projects without explicit overrides inherit the new default automatically. New projects receive a snapshot of the current defaults at creation time so future global changes do not retroactively alter them.
- **Project Settings** -- opened via the gear icon on each project row in the sidebar. Tabs: Appearance, Terminal, Agent, Git (the project-overridable subset). Inherited defaults are shown as hints; overridden settings display a reset button. A "Reset All" footer appears when any overrides exist.

### App-Only Settings

These settings appear only in App Settings and cannot be overridden per-project:

- `sidebarVisible`, `boardLayout`, `sidebar.width`
- `claude.cliPath`, `claude.maxConcurrentSessions`, `claude.queueOverflow`
- `terminal.panelHeight`, `terminal.showPreview`
- `skipDeleteConfirm`, `autoFocusIdleSession`, `activateAllProjectsOnStartup`, `restoreWindowPosition`
- `contextBar.*` (all context bar visibility toggles)
- `notifications.*` (all notification settings)
- `claude.idleTimeoutMinutes`

### Per-Project Overridable Settings

These settings appear in both App Settings (as defaults) and Project Settings (as overrides):

- `theme`
- `terminal.shell`, `terminal.fontSize`, `terminal.fontFamily`, `terminal.scrollbackLines`, `terminal.cursorStyle`
- `claude.permissionMode`
- `git.worktreesEnabled`, `git.autoCleanup`, `git.defaultBaseBranch`, `git.copyFiles`, `git.initScript`

## Full AppConfig Reference

### Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `theme` | ThemeMode | `'dark'` | UI theme. Values: `dark`, `light`, `moon`, `forest`, `ocean`, `ember`, `sand`, `mint`, `sky`, `peach` |
| `sidebarVisible` | boolean | `true` | Show/hide sidebar. Global-only. |
| `boardLayout` | `'horizontal'` \| `'vertical'` | `'horizontal'` | Board scroll direction. Global-only. |
| `skipDeleteConfirm` | boolean | `false` | Skip confirmation dialog on task delete |
| `autoFocusIdleSession` | boolean | `true` | Auto-switch to session tab when agent goes idle |
| `activateAllProjectsOnStartup` | boolean | `true` | Open all projects on app launch (not just the last one). Global-only. |
| `restoreWindowPosition` | boolean | `true` | Remember window size and position between launches. Global-only. |
| `windowBounds` | object \| null | `null` | Persisted window bounds `{x, y, width, height}`. Auto-saved, not shown in UI. |

### terminal.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `terminal.shell` | string \| null | `null` | Shell executable path. `null` = auto-detect. |
| `terminal.fontFamily` | string | `'Consolas, "Courier New", monospace'` | Terminal font family |
| `terminal.fontSize` | number | `14` | Terminal font size (px) |
| `terminal.showPreview` | boolean | `false` | Show terminal preview in task cards. Global-only. |
| `terminal.panelHeight` | number | `250` | Bottom panel height (px). Global-only. |
| `terminal.scrollbackLines` | number | `5000` | Maximum lines kept in terminal buffer (1000-100000) |
| `terminal.cursorStyle` | `'block'` \| `'underline'` \| `'bar'` | `'block'` | Terminal cursor appearance |

### claude.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `claude.permissionMode` | PermissionMode | `'default'` | Default permission mode for spawned agents |
| `claude.cliPath` | string \| null | `null` | Claude CLI path. `null` = auto-detect on PATH. Global-only. |
| `claude.maxConcurrentSessions` | number | `8` | Max concurrent PTY sessions. Global-only. |
| `claude.queueOverflow` | `'queue'` \| `'reject'` | `'queue'` | What to do when max sessions reached. Global-only. |
| `claude.idleTimeoutMinutes` | number | `0` | Auto-suspend sessions after this many minutes idle. 0 = disabled. Global-only. |

PermissionMode values:

- `bypass-permissions` -- `--dangerously-skip-permissions` (no prompts)
- `default` -- uses `--settings` (project-settings behavior)
- `plan` -- `--permission-mode plan` (read-only tools auto-approved)
- `acceptEdits` -- `--permission-mode acceptEdits` (edits auto-approved)
- `manual` -- no flags, interactive prompts (defined in types but not exposed in any UI)

The global App Settings "Permissions" dropdown only offers three choices: `default`, `acceptEdits`, and `bypass-permissions`. The `plan` mode is only available as a per-column override in the Edit Column dialog. The `manual` mode is defined in types but is not exposed in any settings UI.

### git.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `git.worktreesEnabled` | boolean | `true` | Enable git worktrees for task isolation |
| `git.autoCleanup` | boolean | `true` | Delete branches when worktrees are removed |
| `git.defaultBaseBranch` | string | `'main'` | Default base branch for worktrees |
| `git.copyFiles` | string[] | `[]` | Files to copy from repo root into worktrees |
| `git.initScript` | string \| null | `null` | Shell script to run after worktree creation |

### notifications.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `notifications.desktop.onAgentIdle` | boolean | `true` | Desktop notification when agent goes idle on non-visible project |
| `notifications.desktop.onAgentCrash` | boolean | `true` | Desktop notification when session exits with error (always on) |
| `notifications.desktop.onPlanComplete` | boolean | `true` | Desktop notification when plan completes and task auto-moves |
| `notifications.toasts.onAgentIdle` | boolean | `true` | In-app toast when agent goes idle |
| `notifications.toasts.onAgentCrash` | boolean | `true` | In-app toast when session exits with error (always on) |
| `notifications.toasts.onPlanComplete` | boolean | `true` | In-app toast when plan completes |
| `notifications.toasts.durationSeconds` | number | `4` | Toast auto-dismiss time in seconds (1-30) |
| `notifications.toasts.maxCount` | number | `5` | Maximum simultaneous visible toasts (1-10) |
| `notifications.cooldownSeconds` | number | `10` | Minimum wait between repeat desktop notifications per session |

### contextBar.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `contextBar.showShell` | boolean | `true` | Show the shell name (e.g., pwsh, bash) in the context bar |
| `contextBar.showVersion` | boolean | `true` | Show the Claude CLI version |
| `contextBar.showModel` | boolean | `true` | Show the active model name (e.g., Claude Sonnet 4) |
| `contextBar.showCost` | boolean | `true` | Show the cumulative session cost in dollars |
| `contextBar.showTokens` | boolean | `true` | Show token usage (input + output) |
| `contextBar.showContextFraction` | boolean | `true` | Show the context window usage percentage |
| `contextBar.showProgressBar` | boolean | `true` | Show the context window progress bar |

All context bar settings are global-only and cannot be overridden per-project.

### sidebar.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sidebar.width` | number | `400` | Sidebar width (px). Global-only. |
| `skipBoardConfigConfirm` | boolean | `false` | Auto-apply board config changes without confirmation dialog |

## Swimlane-Level Configuration

Each swimlane has its own overrides (stored in the per-project DB):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `permission_strategy` | PermissionMode \| null | null | Permission mode override for this column |
| `auto_spawn` | boolean | true | Whether moving a task here spawns an agent |
| `auto_command` | string \| null | null | Command injected into running session on task arrival |
| `plan_exit_target_id` | string \| null | null | Target column when plan-mode agent exits |

## Board Configuration

Kangentic supports shareable board configuration via JSON files in the project root. This lets teams commit their column layout, colors, icons, actions, and transitions to version control so everyone works with the same board structure.

### Two-File System

- **`kangentic.json`** -- the team file. Committed to git and shared with all collaborators. Contains the canonical board layout.
- **`kangentic.local.json`** -- the personal overrides file. Auto-added to `.gitignore`. Contains per-user customizations (colors, icons, extra columns) that merge on top of the team file.

When both files exist, `kangentic.local.json` is merged over `kangentic.json` by matching columns, actions, and transitions by ID. Unmatched local entries are appended.

### Auto-Export

Every time a project is opened, Kangentic writes the current database state to `kangentic.json` in the project root. This ensures the team always has a current file to commit. If the file already exists and matches the DB state, no write occurs.

### File Watching and Reconciliation

Kangentic watches both `kangentic.json` and `kangentic.local.json` for changes. When a change is detected (e.g., a teammate pulls a new version), a reconciliation banner appears in the UI. The user can apply the changes or dismiss the banner. If `skipBoardConfigConfirm` is enabled, changes are applied automatically without the banner.

Reconciliation matches columns by `id`:
- **Matched columns** are updated with the new properties (name, color, icon, etc.)
- **New columns** (present in file but not in DB) are created
- **Removed columns** (present in DB but absent from the config file and the file has at least one column with an `id`) are handled as follows:
  - If the column has tasks, it becomes a **ghost column** (marked `is_ghost: true`, hidden from the board but preserved so tasks are not lost)
  - If the column is empty, it is deleted

Ghost columns are invisible on the board but still exist in the database. Once all tasks are moved out of a ghost column, it is automatically deleted. This prevents data loss when a teammate removes a column that still holds your in-progress work.

### File Structure

```json
{
  "version": 1,
  "columns": [
    {
      "id": "uuid",
      "name": "Backlog",
      "role": "backlog",
      "icon": "inbox",
      "color": "#6b7280",
      "autoSpawn": false
    },
    {
      "id": "uuid",
      "name": "Executing",
      "icon": "square-terminal",
      "color": "#10b981",
      "autoSpawn": true,
      "permissionStrategy": "default",
      "autoCommand": null
    }
  ],
  "actions": [
    {
      "id": "uuid",
      "name": "Start Agent",
      "type": "spawn_agent",
      "config": { "promptTemplate": "{{title}}{{description}}{{attachments}}" }
    }
  ],
  "transitions": [
    {
      "from": "*",
      "to": "uuid",
      "actions": ["uuid"],
      "executionOrder": [0]
    }
  ]
}
```

### Hand-Written Configs

Config files written by hand (without `id` fields on columns) are treated as additive only. Kangentic will create the specified columns but will not delete or ghost any existing columns. This allows safe experimentation without risking data loss.

## Permission Mode Resolution (Priority Order)

1. Swimlane's `permission_strategy` (if set)
2. Action's `permissionMode` config (if set)
3. Global `config.claude.permissionMode`

## IPC

| Channel | Purpose |
|---------|---------|
| `config:get` | Get effective config (global + project merged) |
| `config:getGlobal` | Get global config only (no project overrides) |
| `config:set` | Update global config (partial merge) |
| `config:getProject` | Get project-level overrides for current project |
| `config:setProject` | Update project-level overrides for current project |
| `config:getProjectByPath` | Get project-level overrides by project path |
| `config:setProjectByPath` | Update project-level overrides by project path |
| `config:syncDefaultToProjects` | Sync changed default values to all existing projects (deep merge) |
| `boardConfig:exists` | Check if `kangentic.json` exists for the active project |
| `boardConfig:export` | Export current board state to `kangentic.json` (auto-runs on project open) |
| `boardConfig:apply` | Apply pending config file changes (reconcile file into DB) |
| `boardConfig:changed` | Event: `kangentic.json` or `kangentic.local.json` changed on disk |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `KANGENTIC_DATA_DIR` | Override the config/data directory path |

## Legacy Migration

On load, the ConfigManager auto-migrates legacy permission mode values:

- `dangerously-skip` → `bypass-permissions`
- `project-settings` → `default`

Same migration runs on swimlane records in the DB.
