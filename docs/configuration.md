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

Settings are split into two panels with separate entry points. Both use a tabbed layout with a sidebar for navigation.

- **App Settings** -- opened via the titlebar gear icon (labeled "Global"). Tabs: Appearance, Terminal, Agent, Git, Behavior. Contains app-wide settings and project defaults. Changing a project default (theme, shell, font, permissions, git) always shows a confirmation modal to optionally sync to all existing projects.
- **Project Settings** -- opened via the gear icon on each project row in the sidebar. Tabs: Appearance, Terminal, Agent, Git. Contains per-project overridable settings. Inherited defaults are shown as hints; overridden settings get a reset button. A "Reset All" footer appears when any overrides exist.

### App-Only Settings

These settings appear only in App Settings and cannot be overridden per-project:

- `sidebarVisible`, `boardLayout`, `sidebar.width`
- `claude.cliPath`, `claude.maxConcurrentSessions`, `claude.queueOverflow`
- `terminal.panelHeight`, `terminal.showPreview`
- `skipDeleteConfirm`, `autoFocusIdleSession`, `notifyIdleOnInactiveProject`, `activateAllProjectsOnStartup`

### Per-Project Overridable Settings

These settings appear in both App Settings (as defaults) and Project Settings (as overrides):

- `theme`
- `terminal.shell`, `terminal.fontSize`, `terminal.fontFamily`
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
| `notifyIdleOnInactiveProject` | boolean | `true` | Show native OS notifications when agents need attention on non-visible projects (idle, permission-blocked, crash, plan completion). Clicking the notification switches to the project and opens the task detail dialog. 10s per-session cooldown. |
| `activateAllProjectsOnStartup` | boolean | `true` | Open all projects on app launch (not just the last one). Global-only. |

### terminal.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `terminal.shell` | string \| null | `null` | Shell executable path. `null` = auto-detect. |
| `terminal.fontFamily` | string | `'Consolas, "Courier New", monospace'` | Terminal font family |
| `terminal.fontSize` | number | `14` | Terminal font size (px) |
| `terminal.showPreview` | boolean | `false` | Show terminal preview in task cards. Global-only. |
| `terminal.panelHeight` | number | `250` | Bottom panel height (px). Global-only. |

### claude.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `claude.permissionMode` | PermissionMode | `'default'` | Default permission mode for spawned agents |
| `claude.cliPath` | string \| null | `null` | Claude CLI path. `null` = auto-detect on PATH. Global-only. |
| `claude.maxConcurrentSessions` | number | `8` | Max concurrent PTY sessions. Global-only. |
| `claude.queueOverflow` | `'queue'` \| `'reject'` | `'queue'` | What to do when max sessions reached. Global-only. |

PermissionMode values:

- `bypass-permissions` -- `--dangerously-skip-permissions` (no prompts)
- `default` -- uses `--settings` (project-settings behavior)
- `plan` -- `--permission-mode plan` (read-only tools auto-approved)
- `acceptEdits` -- `--permission-mode acceptEdits` (edits auto-approved)
- `manual` -- no flags, interactive prompts

### git.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `git.worktreesEnabled` | boolean | `true` | Enable git worktrees for task isolation |
| `git.autoCleanup` | boolean | `true` | Delete branches when worktrees are removed |
| `git.defaultBaseBranch` | string | `'main'` | Default base branch for worktrees |
| `git.copyFiles` | string[] | `[]` | Files to copy from repo root into worktrees |
| `git.initScript` | string \| null | `null` | Shell script to run after worktree creation |

### sidebar.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sidebar.width` | number | `224` | Sidebar width (px). Global-only. |

## Swimlane-Level Configuration

Each swimlane has its own overrides (stored in the per-project DB):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `permission_strategy` | PermissionMode \| null | null | Permission mode override for this column |
| `auto_spawn` | boolean | true | Whether moving a task here spawns an agent |
| `auto_command` | string \| null | null | Command injected into running session on task arrival |
| `plan_exit_target_id` | string \| null | null | Target column when plan-mode agent exits |

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

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `KANGENTIC_DATA_DIR` | Override the config/data directory path |

## Legacy Migration

On load, the ConfigManager auto-migrates legacy permission mode values:

- `dangerously-skip` → `bypass-permissions`
- `project-settings` → `default`

Same migration runs on swimlane records in the DB.
