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

- **Settings Panel** -- opened via the titlebar gear icon or the gear icon on each project row in the sidebar. A project switcher dropdown in the header allows switching between projects. Sidebar tabs: Theme, Terminal, Agent, Git, Shortcuts, Layout, Behavior, MCP Server, Notifications, Privacy. The first five tabs (above the separator) are per-project settings. Four of them (Theme, Terminal, Agent, Git) save to `.kangentic/config.json`, while Shortcuts saves to the board config files (`kangentic.json` and `kangentic.local.json`). The last five (Layout, Behavior, MCP Server, Notifications, Privacy) are shared settings that apply across all projects, saved to the global config. When no project is open, only the 5 shared tabs appear. Changes save immediately. New projects clone settings from the most recently configured project (falling back to defaults if none exist).

### App-Only Settings

These settings appear only in App Settings and cannot be overridden per-project:

- `sidebarVisible`, `boardLayout`, `sidebar.width`
- `cardDensity`, `columnWidth`, `terminalPanelVisible`, `animationsEnabled`, `statusBarVisible`
- `showBoardSearch`, `restoreWindowPosition`
- `agent.cliPaths`, `agent.maxConcurrentSessions`, `agent.queueOverflow`
- `terminal.panelHeight`, `terminal.showPreview`
- `skipDeleteConfirm`, `skipDoneWorktreeConfirm`, `autoFocusIdleSession`, `activateAllProjectsOnStartup`
- `contextBar.*` (all context bar visibility toggles)
- `notifications.*` (all notification settings)
- `agent.idleTimeoutMinutes`

### Per-Project Overridable Settings

These settings appear in both App Settings (as defaults) and Project Settings (as overrides):

- `theme`
- `terminal.shell`, `terminal.fontSize`, `terminal.fontFamily`, `terminal.scrollbackLines`, `terminal.cursorStyle`
- `agent.permissionMode`
- `git.worktreesEnabled`, `git.autoCleanup`, `git.defaultBaseBranch`, `git.copyFiles`, `git.initScript`

## Full AppConfig Reference

### Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `theme` | ThemeMode | `'dark'` | UI theme. Values: `dark`, `light`, `moon`, `forest`, `ocean`, `ember`, `sand`, `mint`, `sky`, `peach` |
| `sidebarVisible` | boolean | `true` | Show/hide sidebar. Global-only. |
| `boardLayout` | `'horizontal'` \| `'vertical'` | `'horizontal'` | Board scroll direction. Global-only. |
| `cardDensity` | `'compact'` \| `'default'` \| `'comfortable'` | `'default'` | Amount of detail shown on task cards. Global-only. |
| `columnWidth` | `'narrow'` \| `'default'` \| `'wide'` | `'default'` | Width of board columns. Global-only. |
| `terminalPanelVisible` | boolean | `true` | Show the terminal panel below the board. Global-only. |
| `animationsEnabled` | boolean | `true` | Enable CSS keyframe animations (idle pulse, dialog fades, status bar pulses). Global-only. |
| `statusBarVisible` | boolean | `true` | Show the status bar at the bottom of the window. Global-only. |
| `skipDeleteConfirm` | boolean | `false` | Skip confirmation dialog on task delete |
| `skipDoneWorktreeConfirm` | boolean | `false` | Delete the local worktree without asking each time a task moves to Done. Branch and session history are always preserved. |
| `autoFocusIdleSession` | boolean | `false` | Auto-switch to session tab when agent goes idle. Idle tabs are always highlighted regardless of this setting. |
| `activateAllProjectsOnStartup` | boolean | `true` | Open all projects on app launch (not just the last one). Global-only. |
| `restoreWindowPosition` | boolean | `true` | Remember window size and position between launches. Global-only. |
| `showBoardSearch` | boolean | `true` | Display the search bar above board columns. Toggle with Ctrl+F / Cmd+F. Global-only. |
| `hasCompletedFirstRun` | boolean | `false` | Whether the user has completed first-run onboarding. Auto-set, not shown in UI. |
| `windowBounds` | object \| null | `null` | Persisted window bounds `{x, y, width, height}`. Auto-saved, not shown in UI. |
| `windowMaximized` | boolean | `false` | Whether the window was maximized at last close. Auto-saved, not shown in UI. |
| `skipBoardConfigConfirm` | boolean | `false` | Auto-apply board config changes without confirmation dialog |
| `statusBarPeriod` | UsageTimePeriod | `'live'` | Time period for status bar usage stats. Values: `live`, `today`, `week`, `month`, `all`. Global-only. |

### terminal.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `terminal.shell` | string \| null | `null` | Shell executable path. `null` = auto-detect. |
| `terminal.fontFamily` | string | `'Menlo, Consolas, "Courier New", monospace'` | Terminal font family |
| `terminal.fontSize` | number | `14` | Terminal font size (px) |
| `terminal.showPreview` | boolean | `false` | Show terminal preview in task cards. Global-only. |
| `terminal.panelHeight` | number | `250` | Bottom panel height (px). Global-only. |
| `terminal.panelCollapsed` | boolean | `false` | Whether the bottom terminal panel is collapsed. Global-only. |
| `terminal.scrollbackLines` | number | `5000` | Lines kept in the visible xterm scrollback (1000-100000). Full session history is preserved separately by the main-process PTY buffer for replay regardless of this value. |
| `terminal.cursorStyle` | `'block'` \| `'underline'` \| `'bar'` | `'block'` | Terminal cursor appearance |

### agent.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agent.permissionMode` | PermissionMode | `'acceptEdits'` | Default permission mode for spawned agents |
| `agent.cliPaths` | Record\<string, string \| null\> | `{}` | Per-agent CLI path overrides keyed by agent name. Empty = auto-detect all. Global-only. |
| `agent.maxConcurrentSessions` | number | `8` | Max concurrent PTY sessions. Global-only. |
| `agent.queueOverflow` | `'queue'` \| `'reject'` | `'queue'` | What to do when max sessions reached. Global-only. |
| `agent.idleTimeoutMinutes` | number | `0` | Auto-suspend sessions after this many minutes idle. 0 = disabled. Global-only. |

PermissionMode values:

- `default` -- uses `--settings` (project-settings behavior)
- `plan` -- `--permission-mode plan` (read-only tools auto-approved)
- `acceptEdits` -- `--permission-mode acceptEdits` (edits auto-approved)
- `dontAsk` -- `--permission-mode dontAsk` (all tools auto-approved except dangerous ones)
- `auto` -- `--permission-mode auto` (classifier-based auto-approval)
- `bypassPermissions` -- `--dangerously-skip-permissions` (no prompts at all)

All six modes are available in both the global App Settings "Permissions" dropdown and the per-column Edit Column dialog. The dropdown shows only the modes supported by the active agent (e.g., Cursor CLI only exposes Interactive and Non-Interactive; Oz CLI exposes Plan, Default, and Auto via Warp agent profiles).

### git.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `git.worktreesEnabled` | boolean | `true` | Enable git worktrees for task isolation |
| `git.autoCleanup` | boolean | `true` | Delete branches when worktrees are removed |
| `git.defaultBaseBranch` | string | `'main'` | Default base branch for worktrees |
| `git.copyFiles` | string[] | `[]` | Files to copy from repo root into worktrees |
| `git.initScript` | string \| null | `null` | Shell script to run after worktree creation |

### Shortcuts

Shortcuts are custom command buttons displayed in the task detail dialog header and kebab menu. They are configured in the Shortcuts settings tab (not stored in `AppConfig`). Shortcut definitions are saved in the board config files:

- **Team shortcuts** in `kangentic.json` (committed, shared)
- **Personal shortcuts** in `kangentic.local.json` (gitignored, local-only)

Each shortcut has a label, Lucide icon name, shell command, and display location (header, menu, or both).

Template variables available in shortcut commands (defined in `src/shared/template-vars.ts`):

| Variable | Value |
|----------|-------|
| `{{cwd}}` | Working directory (worktree path or project path) |
| `{{branchName}}` | Git branch name |
| `{{taskTitle}}` | Task title (shell-sanitized to prevent injection) |
| `{{projectPath}}` | Project root directory path |

IPC channels for shortcuts are in the Board Config group: `boardConfig:getShortcuts`, `boardConfig:setShortcuts`, `boardConfig:shortcutsChanged`.

### mcpServer.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mcpServer.enabled` | boolean | `true` | Allow agents to create and query tasks via MCP tools. When disabled, no kangentic MCP server is injected into sessions. See [MCP Server](mcp-server.md). |

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
| `contextBar.showVersion` | boolean | `true` | Show the agent CLI version |
| `contextBar.showModel` | boolean | `true` | Show the active model name (e.g., Claude Sonnet 4) |
| `contextBar.showCost` | boolean | `true` | Show the cumulative session cost in dollars |
| `contextBar.showTokens` | boolean | `true` | Show token usage (input + output) |
| `contextBar.showContextFraction` | boolean | `true` | Show the context window usage percentage |
| `contextBar.showProgressBar` | boolean | `true` | Show the context window progress bar |
| `contextBar.showRateLimits` | boolean | `true` | Show Claude Code 5-hour and weekly plan-usage quota bars (Claude only) |

All context bar settings are global-only and cannot be overridden per-project.

### backlog.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backlog.priorities` | Array<{ label: string; color: string }> | See below | Priority levels for backlog items. Default: None (#6b7280), Low (#3b82f6), Medium (#eab308), High (#f97316), Urgent (#ef4444). |
| `backlog.labelColors` | Record<string, string> | `{}` | Mapping of label names to hex colors for backlog item labels. Empty by default; colors are assigned as labels are created. |

### sidebar.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sidebar.width` | number | `400` | Sidebar width (px). Global-only. |

### Privacy

The Privacy tab is informational only - it has no configurable keys. It displays what anonymous analytics Kangentic collects (app launches, platform, crash reports, task/session counts) and what it does not collect (task content, file paths, usernames, code). Analytics are powered by Aptabase (no cookies, no persistent identifiers, GDPR-compliant). Set `KANGENTIC_TELEMETRY=0` as an environment variable to opt out.

## Swimlane-Level Configuration

Each swimlane has its own overrides (stored in the per-project DB):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `permission_mode` | PermissionMode \| null | null | Permission mode override for this column |
| `auto_spawn` | boolean | true | Whether moving a task here spawns an agent |
| `auto_command` | string \| null | null | Command injected into running session on task arrival |
| `plan_exit_target_id` | string \| null | null | Target column when plan-mode agent exits |
| `agent_override` | string \| null | null | Agent CLI override for sessions spawned in this column |
| `handoff_context` | boolean | false | When enabled, cross-agent transitions package prior session context for the target agent |

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
      "name": "To Do",
      "role": "todo",
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
      "permissionMode": "default",
      "autoCommand": null,
      "planExitTarget": null,
      "agentOverride": null,
      "handoffContext": false,
      "archived": false
    }
  ],
  "defaultBaseBranch": "main",
  "shortcuts": [],
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
  ],
  "_modifiedBy": "device-id"
}
```

The `defaultBaseBranch` field sets the team-shared default base branch for worktree creation. When present, it takes precedence over the per-user `git.defaultBaseBranch` in `AppConfig`. Individual users can override it via `kangentic.local.json`.

The `_modifiedBy` field is auto-set by Kangentic to identify which device last wrote the file. It is used internally for change detection and should not be edited manually.

### Hand-Written Configs

Config files written by hand (without `id` fields on columns) are treated as additive only. Kangentic will create the specified columns but will not delete or ghost any existing columns. This allows safe experimentation without risking data loss.

## Permission Mode Resolution (Priority Order)

1. Swimlane's `permission_mode` (if set)
2. Global `config.agent.permissionMode`

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
| `boardConfig:setDefaultBaseBranch` | Update the default base branch in `kangentic.json` |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `KANGENTIC_DATA_DIR` | Override the config/data directory path |

## Legacy Migration

On load, the ConfigManager auto-migrates legacy permission mode values:

- `dangerously-skip` → `bypassPermissions`
- `bypass-permissions` → `bypassPermissions`
- `manual` → `default` (removed as a separate mode)
- `project-settings` → `default`

Same migration runs on swimlane records in the DB.
