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

- **Settings Panel** -- opened via the titlebar gear icon or the gear icon on each project row in the sidebar. A project switcher dropdown in the header allows switching between projects. Sidebar tabs: General, Theme, Terminal, Agent, Git, Browser, Shortcuts, Layout, Behavior, Dictation, Memory, Hotkeys, MCP Server, Agent Browser, Notifications, Mobile Devices, Privacy, Developer. The first seven tabs (above the separator) are per-project settings. Five of them (Theme, Terminal, Agent, Git, Browser) save to `.kangentic/config.json`, Shortcuts saves to the board config files (`kangentic.json` and `kangentic.local.json`), and the General tab edits the project record in the global index database. The General tab exposes the `project.location` setting -- the folder on disk the project points at -- with a "Change..." button to re-point the project after its folder is moved or renamed; because tasks and history are keyed by project id, they are preserved across a relocation. The Agent tab exposes the `project.defaultAgent` setting (the "Agent" combobox) -- the agent CLI used for new sessions in this project -- along with `project.defaultModel` and `project.defaultEffort` (the "Model" and "Effort" comboboxes), the project-level model and reasoning-effort defaults applied when no column or task override is set. Like `project.location`, all three are stored on the project record in the global index database rather than in `AppConfig`. When the selected agent declares remote-execution support (today: OpenCode only), the Agent tab also shows an Execution mode row right below the CLI Path row, letting the project run that agent locally (the default) or attach to a server it declares support for - see [Remote Execution](#remote-execution) below; an agent without the capability shows none of these rows. The last eleven (Layout, Behavior, Dictation, Memory, Hotkeys, MCP Server, Agent Browser, Notifications, Mobile Devices, Privacy, Developer) are shared settings that apply across all projects, saved to the global config. When no project is open, only the 11 shared tabs appear. Changes save immediately. New projects inherit only the seeded settings subset (`theme`, `terminal.*`, `agent.permissionMode`, `git.*`) from the most recently configured project, falling back to defaults if none exist. Project-specific data such as `browser.defaultUrl`, `importSources`, and `agent.execution` (a remote server's working directory is specific to the project it was configured for) is stored per-project and is never cloned into a new project.

### App-Only Settings

These settings appear only in App Settings and cannot be overridden per-project:

- `sidebarVisible`, `boardLayout`, `sidebar.width`
- `cardDensity`, `columnWidth`, `showTaskNumbers`, `terminalPanelVisible`, `animationsEnabled`, `statusBarVisible`, `diffViewMode`
- `diffDefaultScope`, `diffIgnoreWhitespace`, `diffCollapseUnchanged`, `diffFileSort`, `diffFlatList`
- `restoreWindowPosition`
- `agent.cliPaths`, `agent.maxConcurrentSessions`, `agent.queueOverflow`, `agent.autoResumeSessionsOnRestart`
- `agent.executionServers` (per-agent remote-server url + auth; the Agent tab's Server URL / Authentication fields, shown when the selected agent declares remote-execution support)
- `agent.launchOptions` (per-agent boolean startup toggles; the Agent tab's Launch Options rows, shown when the selected agent declares launch-option capability)
- `terminal.panelHeight`, `terminal.showPreview`, `terminal.colors`
- `autoFocusIdleSession`
- `skipBoardConfigConfirm`
- `windowLightDismiss`
- `contextBar.*` (all context bar visibility toggles)
- `notifications.*` (all notification settings)
- `agent.idleTimeoutMinutes`
- `developer.activityDebugOverlay`, `developer.persistConsoleLogs`, `developer.recordIpcTraffic`, `developer.previewInspectionServer`, `developer.previewEvalEnabled`
- `browserAutomation.enabled`, `browserAutomation.allowInteraction`, `browserAutomation.allowNavigation`, `browserAutomation.allowEval`, `browserAutomation.restrictNavigationToLocalhost`
- `dictation.*` (all voice dictation settings)
- `memory.*` (conversation search + recall, in the Memory tab)
- `mobileBridge.*` (mobile companion app pairing/relay, in the Mobile Devices tab)
- `hotkeyOverrides`

### Per-Project Overridable Settings

These settings appear in both App Settings (as defaults) and Project Settings (as overrides):

- `theme`
- `terminal.shell`, `terminal.fontSize`, `terminal.fontFamily`, `terminal.scrollbackLines`, `terminal.cursorStyle`
- `agent.permissionMode`
- `git.worktreesEnabled`, `git.autoCleanup`, `git.defaultBaseBranch`, `git.copyFiles`, `git.initScript`, `git.linkNodeModules`, `git.prRefreshIntervalMinutes`
- `browser.enabled`, `browser.defaultUrl`
- `agent.execution` (per-agent local/remote mode + server working directory; editable inline in the Agent tab for the currently-selected agent, but NOT seeded into new projects - see below)

> **Seeded vs. stored.** All settings above are stored per-project in `.kangentic/config.json` and editable in Project Settings. When a *new* project is created it is seeded with only `theme`, `terminal.*`, `agent.permissionMode`, and `git.*` (via `pickOverridableSubset` in `config-manager.ts`). `browser.*`, `agent.execution`, and non-setting project data such as `importSources`, are kept per-project and never cloned, so one project's dev-server URL, remote-server directory, or import sources cannot leak into another.

## Full AppConfig Reference

### Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `theme` | ThemeMode | `'dark'` | UI theme. Values: `dark`, `light`, `moon`, `forest`, `ocean`, `ember`, `sand`, `mint`, `sky`, `peach` |
| `sidebarVisible` | boolean | `true` | Show/hide sidebar. Global-only. |
| `boardLayout` | `'horizontal'` \| `'vertical'` | `'horizontal'` | Board scroll direction. Global-only. |
| `cardDensity` | `'compact'` \| `'default'` \| `'comfortable'` | `'default'` | Amount of detail shown on task cards. Global-only. |
| `columnWidth` | `'narrow'` \| `'default'` \| `'wide'` | `'default'` | Width of board columns. Global-only. |
| `showTaskNumbers` | boolean | `true` | Show each task's `#N` (`display_id`) as a muted badge in the board card header. On by default; matches the number shown in the task detail header. Global-only. |
| `terminalPanelVisible` | boolean | `true` | Show the terminal panel below the board. Global-only. |
| `animationsEnabled` | boolean | `true` | Enable CSS keyframe animations (idle pulse, dialog fades, status bar pulses). Global-only. |
| `statusBarVisible` | boolean | `true` | Show the status bar at the bottom of the window. Global-only. |
| `diffViewMode` | `'split'` \| `'inline'` | `'split'` | Default layout for Git file diffs in the Changes panel (`split` = side by side, `inline` = unified). The in-diff toggle and the Layout settings tab write this same key, so the choice sticks. Global-only. |
| `diffDefaultScope` | `'working'` \| `'staged'` \| `'branch'` | `'working'` | Which changes a freshly opened Changes panel shows: `working` (uncommitted edits vs the index), `staged` (index vs HEAD), or `branch` (the whole branch vs its base). The in-panel scope control overrides it per session. Global-only. |
| `diffIgnoreWhitespace` | boolean | `false` | Hide whitespace-only changes in the diff to filter reformatting noise. The in-diff toggle and the Layout tab write this key. Global-only. |
| `diffCollapseUnchanged` | boolean | `false` | Fold away large unchanged regions so only changed hunks (with a little surrounding context) are shown. Global-only. |
| `diffFileSort` | `'name'` \| `'status'` \| `'size'` | `'name'` | How the Changes panel orders files: by name, by status (added / modified / deleted), or by size (most changes first). Global-only. |
| `diffFlatList` | boolean | `false` | Show changed files as a flat list of full paths instead of a nested directory tree. Global-only. |
| `skipDeleteConfirm` | boolean | `false` | Skip confirmation dialog on task delete. Written by the delete dialog's "don't ask again" checkbox. No longer surfaced in the Settings panel. |
| `autoFocusIdleSession` | boolean | `false` | Auto-switch to session tab when agent goes idle. Idle tabs are always highlighted regardless of this setting. |
| `windowLightDismiss` | `'off'` \| `'single'` \| `'focused'` \| `'all'` | `'single'` | Click-outside (light-dismiss) policy for modeless task-detail windows. `off` disables; `single` closes the lone window (any state); `focused` closes the focused window (any state); `all` closes every window. Closing a window does not kill its session. Global-only. |
| `restoreWindowPosition` | boolean | `true` | Remember window size and position between launches. Global-only. |
| `hasCompletedFirstRun` | boolean | `false` | Whether the user has completed first-run onboarding. Auto-set, not shown in UI. |
| `windowBounds` | object \| null | `null` | Persisted window bounds `{x, y, width, height}`. Auto-saved, not shown in UI. |
| `windowMaximized` | boolean | `false` | Whether the window was maximized at last close. Auto-saved, not shown in UI. |
| `popOutBounds` | object | `{}` | Persisted bounds + last target display id for each detached pop-out surface (usage stats, git changes, the Browser pane), keyed by `PopOutKind` so a surface reopens on the monitor it was last placed on. Auto-saved, not shown in UI. |
| `workspaceByProject` | Record\<string, object\> | `{}` | In-app window-manager layout keyed by project ID: each entry holds the open windows (task-detail or conversation), their tiling tree, and fractional geometry. Persisted per-project (survives a project switch and an app restart), restored after sessions resolve, and anchored by taskId (task-detail) or session id (conversation) so a session respawn never orphans a window. Each entry carries a schema `version` and is clamped/validated on restore. Auto-saved, not shown in UI. |
| `commandTerminalWorkspace` | object \| null | `null` | GLOBAL layout for the Command Terminal window layer (Ctrl+Shift+P): the open command terminal window(s) and their tiling, shared across ALL projects (one blob, not keyed by project). Slot-anchored and fractional; the session stays per-project and ephemeral, so only the geometry/arrangement persists. Same schema shape as a `workspaceByProject` entry. Auto-saved, not shown in UI. |
| `skipBoardConfigConfirm` | boolean | `false` | When a `kangentic.json` board change is detected (from a teammate or your own pulled-back commit), apply it immediately instead of showing the confirmation dialog. Global-only. |
| `statusBarPeriod` | UsageTimePeriod | `'live'` | Deprecated. Drove the old status-bar usage strip (removed in favor of the usage dashboard); now read once as a seed fallback for `usageStatsPeriod` and never written. Global-only. |
| `usageStatsPeriod` | UsageTimePeriod | `'live'` | Persisted time range for the usage stats dashboard. Values: `live`, `today`, `week`, `month`, `all`. One global value shared across all projects. Global-only. |
| `usageStatsScope` | `'project'` \| `'all'` | `'project'` | Persisted scope for the usage stats dashboard: the current project (`project`) or the app-wide all-projects rollup (`all`). Global-only. |
| `lastActiveTaskByProject` | Record\<string, string\> | `{}` | Per-project memory of the last user-clicked task tab in the terminal panel, keyed by project ID. Restored on project switch. Auto-saved, not shown in UI. |
| `autoNameAskedTaskIds` | string[] | `[]` | Task IDs that have already been offered an auto-rename suggestion. Persisted so a dismissed suggestion does not reappear next launch. Drained on task delete (single + bulk delete handlers in `task-crud.ts`). Auto-saved, not shown in UI. |
| `autoNameRateLimitPerHour` | number | `60` | Maximum auto-name CLI calls per rolling 60-minute window. Caps cost on burst task creation. `0` disables the limit. Enforced in the `agent:summarize` IPC handler. Global-only, not currently surfaced in the Settings panel. |
| `discoveredModelsByAgent` | Record\<string, string[]\> | `{}` | Persisted union of every model ID seen for each agent. Sources: `discoverCapabilities()` (Claude reads `~/.claude/projects/` JSONL and harvests ids from the CLI's `/model` picker via a background-warmed hidden PTY probe), live `usage.model.id` from running sessions (via `rememberDiscoveredModel` in `config-store.ts`), and override picks. Keyed by agent name. Backs the model dropdowns in the New Task / Edit dialogs and column manager so they learn new models without re-walking JSONL on each launch. Auto-saved, not shown in UI. |
| `discoveredContextWindowsByAgent` | Record\<string, Record\<string, number\>\> | `{}` | Empirically-observed context-window size (tokens) per model, learned from a live session's `status.json` (`context_window.context_window_size`, via `rememberModelContextWindow` in `config-store.ts`). Keyed by agent name, then by BASE model id (the `[1m]`/dated suffix stripped). The window is not derivable from a model id alone (a plain `claude-opus-4-8` runs 1M on a 1M-entitled account, 200K elsewhere), so it is discovered from telemetry rather than hardcoded. Backs the context-size badge (`1M` / `200K`) on the model dropdowns, which appears only for a model whose window has actually been observed. Last-observation-wins. Auto-saved, not shown in UI. |
| `hotkeyOverrides` | Record\<string, string\> | `{}` | User hotkey overrides: keybinding action id (e.g. `commandBar.toggle`) to a canonical combo string. A combo is either a keyboard chord (e.g. `Mod+Shift+K`, where `Mod` is Cmd on macOS and Ctrl elsewhere) or a mouse button (`Mouse:Middle`, `Mouse:Back`, `Mouse:Forward`), so any action can be rebound to either input. Absent keys use the registry default in `src/shared/keybindings.ts`. Edited in the Hotkeys settings tab; replaced wholesale on save (a `CONFIG_DICTIONARY_PATHS` entry) so a reset deletes the key. Global-only. |

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
| `terminal.colors` | `TerminalColorOverrides` | `{}` | Custom terminal background, foreground, and cursor color, edited via color swatches in the Layout settings tab's Terminal section. Any slot left unset falls back to the built-in default: background `#0c0c0c`, foreground/cursor `#e4e4e7`. The 16-color ANSI palette (based on Windows Terminal's "Campbell" scheme) is a fixed built-in scheme, not exposed for per-color editing. `cursorAccent` always tracks the resolved background (for cursor legibility) and `selectionBackground` is a fixed app accent; neither is user-customizable. A dictionary-style field (`CONFIG_DICTIONARY_PATHS`): saved wholesale so resetting a slot actually deletes it. Global-only. |

### agent.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agent.permissionMode` | PermissionMode | `'acceptEdits'` | Default permission mode for spawned agents |
| `agent.cliPaths` | Record\<string, string \| null\> | `{}` | Per-agent CLI path overrides keyed by agent name. Empty = auto-detect all. Global-only. |
| `agent.maxConcurrentSessions` | number | `8` | Max concurrent PTY sessions. Global-only. |
| `agent.queueOverflow` | `'queue'` \| `'reject'` | `'queue'` | What to do when max sessions reached. Global-only. |
| `agent.idleTimeoutMinutes` | number | `0` | Auto-suspend sessions after this many minutes idle. 0 = disabled. Global-only. |
| `agent.autoResumeSessionsOnRestart` | boolean | `true` | When true, agent sessions that were running at last close auto-resume when Kangentic restarts. When false, sessions stay paused and require a manual Resume click on each task. Turn off if auto-resuming many agents at once overwhelms your machine. Global-only. |
| `agent.executionServers` | Record\<string, AgentExecutionServer\> | `{}` | Global, agent-keyed remote-server identity: `{ url, auth }`. `auth` is `{kind:'none'}`, `{kind:'basic', username, password}`, or `{kind:'bearerEnv', envVarName}`. Machine-scoped like `agent.cliPaths` - names a server, not a project. Global-only. |
| `agent.execution` | Record\<string, AgentProjectExecution\> | `{}` | Per-project, agent-keyed: `{ mode: 'local' \| 'remote', workingDirectory }`. An absent entry means local. `workingDirectory` is a path ON THE SERVER for this project's tasks. See [Remote Execution](#remote-execution). |
| `agent.launchOptions` | Record\<string, Record\<string, boolean\>\> | `{}` | Global, agent-keyed boolean startup toggles: agent name -> option id -> enabled. An absent entry falls back to the adapter's declared default. Machine-scoped like `agent.cliPaths`. Global-only. Today only Codex declares one option, `disableApps` (launches with `--disable apps` to skip the optional cloud ChatGPT Apps MCP connector, which can hang startup at "Booting MCP server: codex_apps"). |

PermissionMode values:

- `default` -- uses `--settings` (project-settings behavior)
- `plan` -- `--permission-mode plan` (read-only tools auto-approved)
- `acceptEdits` -- `--permission-mode acceptEdits` (edits auto-approved)
- `dontAsk` -- `--permission-mode dontAsk` (all tools auto-approved except dangerous ones)
- `auto` -- `--permission-mode auto` (classifier-based auto-approval)
- `bypassPermissions` -- `--dangerously-skip-permissions` (no prompts at all)

All six modes are available in both the global App Settings "Permissions" dropdown and the per-column Edit Column dialog. The dropdown shows only the modes supported by the active agent (e.g., Cursor CLI only exposes Interactive and Non-Interactive; Oz CLI exposes Plan, Default, and Auto via Warp agent profiles).

### Remote Execution

An agent adapter can declare `remoteExecution` on `AgentAdapter` (`src/main/agent/agent-adapter.ts`) to support attaching to a server the user runs, instead of always spawning a local process. Today only OpenCode declares it (`opencode attach <url> --dir <serverPath>`). The fields live inline in the Agent settings tab, right after the CLI Path row, and render only when the currently-selected agent declares the capability (`AgentExecutionFields` in `src/renderer/components/settings/tabs/agent-execution-fields.tsx`) - an agent without it (everyone else) shows none of these rows, since the Agent tab only ever displays the one currently-selected agent.

The configuration splits along a scope seam:

- **`agent.executionServers[name]`** (global) is the server's identity - URL and auth. It is machine-scoped, like `agent.cliPaths`: the same server is available to every project on this machine.
- **`agent.execution[name]`** (per-project) is this project's use of that server - `local` or `remote`, and if remote, the working directory ON THE SERVER for this project's tasks. It is intentionally excluded from new-project seeding (see the seeding note above) - a remote server's directory is specific to the project it was configured for.

At spawn time, `resolveExecutionTarget()` (`src/main/agent/shared/execution-target.ts`) combines both into a single `ResolvedExecutionTarget` and threads it through `CommandOptions.executionTarget`, populated at both spawn chokepoints (`transition-engine.ts`, `session-startup/prepare-spawn.ts`) per `spawn-entry-point-parity.md`. It throws (rather than silently spawning locally) if a project's mode is `remote` but no server URL is configured.

An adapter may also set `AgentRemoteExecutionInfo.remoteModeCaveat` - a short string shown under the remote fields (e.g. which Kangentic features, like MCP or the activity plugin, are unavailable in remote mode for that agent). The renderer only ever renders whatever string the adapter provides; it never branches on agent name to decide the copy, per `agent-adapters-boundary.md`.

When a project's mode for an agent is `remote`:

- `ensureTaskWorktree` (`src/main/ipc/helpers/task-git.ts`) skips creating a local git worktree - the task's `worktree_path` stays `null`, and the configured server-side directory travels separately via `executionTarget`, never through `cwd`.
- For OpenCode specifically: the local `probeAuth()` (reads `~/.local/share/opencode/auth.json`) is bypassed in favor of a `GET /global/health` reachability probe (`remoteExecution.probeServer`, surfaced to the renderer's "Test connection" button via the `agent:probeExecutionServer` IPC channel); the transcript is read over HTTP (`GET /session/:id/message`) instead of the local SQLite database; the activity plugin is not installed (the server's filesystem is not local); and the Kangentic MCP server is not wired in. This is not a reachability problem `mcpServer.callbackHost` can fix: `opencode attach <url>` is a stateless HTTP client to a server that was started, and had its config fixed, independently and earlier - its CLI surface has no config-push flags, so env vars Kangentic sets on the spawned attach process are never read by the already-running server, whether that server is local or genuinely remote. See [MCP Server > Network Access](mcp-server.md) for the full reasoning and the (non-durable, since port/token rotate on restart) manual workaround. PTY-silence activity detection and PTY-output session-ID capture both continue to work unchanged, since `opencode attach` still runs a real TUI over the local PTY.

### git.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `git.worktreesEnabled` | boolean | `true` | Enable git worktrees for task isolation |
| `git.autoCleanup` | boolean | `true` | Delete branches when worktrees are removed |
| `git.defaultBaseBranch` | string | `'main'` | Default base branch for worktrees |
| `git.copyFiles` | string[] | `[]` | Files to copy from repo root into worktrees |
| `git.initScript` | string \| null | `null` | Shell script run in each new worktree after creation (and after `node_modules` linking). Runs via the platform shell (cmd.exe on Windows, sh on POSIX). A non-zero exit, timeout (10 min cap), or cancellation fails worktree creation. |
| `git.linkNodeModules` | boolean | `true` | Symlink the root `node_modules` into each worktree so agents skip a fresh install. Disable to let `git.initScript` install dependencies inside the worktree instead. |
| `git.prRefreshIntervalMinutes` | number \| null | `5` | Minutes between background PR sweeps while the project is open. Each sweep refreshes linked PRs' state and discovers/links a PR for an unlinked task with a live worktree. `null` = off (the on-open sweep still runs) |

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
| `mcpServer.bindAddress` | string | `'127.0.0.1'` | Interface the in-process MCP HTTP server listens on. Not exposed in Settings UI - edit `config.json` directly. Widening past loopback exposes the server to other machines; read once at startup. Use a wildcard (`0.0.0.0`), which binds loopback too - binding one specific non-loopback interface leaves loopback unbound and breaks every local agent. See [MCP Server > Network Access](mcp-server.md). |
| `mcpServer.callbackHost` | string \| undefined | unset | Not exposed in Settings UI - edit `config.json` directly. Allowlisted alongside `bindAddress` for DNS-rebinding-protection so a real external request is not rejected. Does not auto-wire a remote OpenCode session (see [MCP Server > Network Access](mcp-server.md)). |

### notifications.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `notifications.desktop.onAgentIdle` | boolean | `true` | Desktop notification when agent goes idle on non-visible project |
| `notifications.desktop.onAgentCrash` | boolean | `true` | Desktop notification when session exits with error (always on) |
| `notifications.desktop.onPlanComplete` | boolean | `true` | Desktop notification when plan completes and task auto-moves |
| `notifications.desktop.onSpawnStalled` | boolean | `true` | Desktop notification when a task spawn stays in a preparing phase (worktree/git queue) past the stall threshold (~8s) |
| `notifications.toasts.onAgentIdle` | boolean | `true` | In-app toast when agent goes idle |
| `notifications.toasts.onAgentCrash` | boolean | `true` | In-app toast when session exits with error (always on) |
| `notifications.toasts.onPlanComplete` | boolean | `true` | In-app toast when plan completes |
| `notifications.toasts.onSpawnStalled` | boolean | `true` | In-app toast (with a Cancel action) when a task spawn stalls past the threshold while preparing |
| `notifications.toasts.durationSeconds` | number | `4` | Toast auto-dismiss time in seconds (1-30) |
| `notifications.toasts.maxCount` | number | `5` | Maximum simultaneous visible toasts (1-10) |
| `notifications.cooldownSeconds` | number | `10` | Minimum wait between repeat desktop notifications per session |

### contextBar.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `contextBar.showShell` | boolean | `true` | Show the shell name (e.g., pwsh, bash) in the context bar |
| `contextBar.showVersion` | boolean | `true` | Show the agent CLI version |
| `contextBar.showElapsed` | boolean | `true` | Show the ticking wall-clock elapsed time since the session started |
| `contextBar.showCost` | boolean | `true` | Show the cumulative session cost in dollars |
| `contextBar.showToolCalls` | boolean | `true` | Show the live cumulative tool-call count (click for the per-tool breakdown) |
| `contextBar.showAgentActive` | boolean | `false` | Show the agent active time reported by the CLI |
| `contextBar.showTokens` | boolean | `true` | Show token usage (input + output) |
| `contextBar.showContextFraction` | boolean | `true` | Show the context window usage percentage |
| `contextBar.showProgressBar` | boolean | `true` | Show the context window progress bar |
| `contextBar.showRateLimits` | boolean | `true` | Show adapter-reported plan-usage quota bars. Each window is self-described by the agent adapter (e.g. Claude reports a 5-hour session and 7-day weekly window). Hidden for adapters that do not report rate limits. |

The model and effort pills are intentionally NOT toggleable. They double as in-place picker triggers (clicking them opens a popover that lets the user switch models/effort without restarting the session), so a "hide" toggle would silently disable that feature. They render whenever a session reports a model.

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

### browser.*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `browser.enabled` | boolean | `true` | Show the Browser pill in task detail headers. Disable for security-sensitive projects that should not embed external sites. Per-project overridable (stored per-project; not seeded into new projects). |
| `browser.defaultUrl` | string \| undefined | `undefined` | Project default URL when a task has no per-task URL override. Auto-saved when the user first navigates the Browser pane. Per-project overridable (stored per-project; not seeded into new projects). |

**Action (not a config key):** the Browser tab also exposes a destructive **Clear Browser Data** button (registry id `browser.clearStorage`) that wipes cookies, localStorage, IndexedDB, service workers, and HTTP/auth caches across the per-worktree embedded browser partitions (`persist:kngbrowser-<hash(worktreePath)>`) plus the legacy shared jar (`persist:kangentic-browser`). Saved URLs are kept. Backed by the `browser:clearStorage` IPC channel; not persisted in `AppConfig`.

### browserAutomation.*

Global-only policy (no per-project override) for whether and how an agent may drive the embedded Browser pane via the `kangentic_browser_*` MCP tools. Distinct from `browser.*` (the per-project pane settings); lives below the settings separator in its own **Agent Browser** tab and is read live on each tool call.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `browserAutomation.enabled` | boolean | `true` | Master switch. When false the entire `kangentic_browser_*` family returns an actionable disabled error. |
| `browserAutomation.allowInteraction` | boolean | `true` | Allow click / type / keypress / drag. When false the agent is observe-only (screenshots and DOM reads still work). |
| `browserAutomation.allowNavigation` | boolean | `true` | Allow navigating the pane to other URLs. When false the agent is confined to the loaded page. |
| `browserAutomation.allowEval` | boolean | `false` | Allow `kangentic_browser_eval` (arbitrary JavaScript in the loaded page's origin). Off by default - the one unbounded primitive. |
| `browserAutomation.restrictNavigationToLocalhost` | boolean | `false` | Only allow navigation to localhost / private hosts, never public sites. Off by default (any http(s) URL allowed). |

### Dictation

Free, fully-local push-to-talk voice-to-text into the focused terminal: hold a key (default a mouse
side button), speak, watch a live transcript stream into the input, and on release the finalized text
is inserted (and optionally submitted). Global-only (App Settings only; no per-project override).
Engines run on-device via `sherpa-onnx-node`; a Cloud refinement option routes only the final clip to
an OpenAI-compatible endpoint. The first six keys below are settings-panel rows; the rest are
config-only (driven by the Mode preset + Live/Refinement model dropdowns).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dictation.enabled` | boolean | `false` | Master on/off. Shows the mic button and enables push-to-talk. (Transcription section row.) |
| `dictation.language` | string (BCP-47) | `'en'` | Spoken language. The Live/Refinement model dropdowns narrow to models that support it; non-English uses the multilingual Whisper builds. (Transcription section row.) |
| `dictation.punctuation` | boolean | `true` | Add punctuation + capitalization to the committed text. (Transcription section row.) |
| `dictation.autoSubmit` | boolean | `true` | Press Enter automatically after inserting (via the paste engine's settle -> Enter -> evidence path), or leave the text in the input for review. (Input section row.) |
| `dictation.releaseBufferMs` | number | `250` | Keep capturing this many ms after release so the last word is not clipped; snaps to 50ms steps (0-500); 0 = off. (Input section row.) |
| `dictation.remote` | DictationRemoteEndpoint \| undefined | `undefined` | OpenAI-compatible `/v1/audio/transcriptions` endpoint (`url`, `apiKey`, `model`) used when the Refinement model is set to Cloud. (Cloud backend section row.) |
| `dictation.engineMode` | DictationEngineMode | `'auto'` | Engine selection (`'auto'` tiers by hardware; `'remote'` = cloud final). Config-only; set by the Refinement dropdown's Cloud option. |
| `dictation.modelId` | string \| null | `null` | The FINAL (accurate) model id, `null` = the tier default (Parakeet), `'none'` = no post-processing pass. Config-only (Refinement dropdown). |
| `dictation.liveModelId` | string \| null | `undefined` | The LIVE (preview) model id: absent = the streaming Zipformer, an offline id = chunked live, `'none'` = no live preview. Config-only (Live dropdown). |
| `dictation.mode` | `'fast'`/`'balanced'`/`'accurate'`/`'custom'` | `undefined` | Quality preset. A preset sets AND locks the Live + Refinement models; `'custom'` unlocks them. UI-only; the engine reads the resolved model ids. |
| `dictation.experience` | `'popup'`/`'docked'`/`'live'` | `'popup'` | Live UI surface. Ships as `'live'` (transcript types straight into the terminal). Config-only. |

### Hotkeys

Lists every keyboard hotkey grouped by area (General, Task Detail, Git Changes, Windows, Browser, Terminal, Developer) and lets the user rebind the configurable ones. Global-only (per-machine). Each row's capture widget records the next key chord or a mouse button press (middle or side buttons, so an action can be bound to either input; Escape cancels) and probes whether that combo is already claimed by the OS or another app (via the `keybindings:probeGlobal` IPC channel), warning if so. Two actions resolving to the same combo in overlapping scopes are flagged as a conflict. Reset-to-default is available per row and for all at once. Terminal clipboard combos (Copy, Paste) and Escape are shown read-only. The registry of every hotkey + default combo lives in `src/shared/keybindings.ts`; handlers read their effective combo through the `useKeybinding` hook. Overrides persist to the `hotkeyOverrides` key (see the Top-Level table above). The **Git Changes** group adds four cross-file diff-navigation hotkeys for the Changes panel, scoped to the task dialog and gated on the focused window: `changes.nextChange` (Alt+Down, also F7) and `changes.prevChange` (Alt+Up, also Shift+F7) step through hunks and roll over into the adjacent file at the boundaries, while `changes.nextFile` (Alt+Shift+Down) and `changes.prevFile` (Alt+Shift+Up) jump whole files.

### Memory

The Memory tab hosts conversation search + recall - a local index over agent conversation transcripts powering the Quick Find "Conversations" group (for you) and the `kangentic_search` MCP tool (for agents). It sits next to Dictation (both are on-device, keyless, model-backed AI features). Global-only (per-machine). Keyword search is on by default; the semantic layer is opt-in.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `memory.indexingEnabled` | boolean | `true` | Index agent conversation transcripts locally for search and recall. Off: no indexing runs, no conversation hits appear in Quick Find or `kangentic_search`, and the embed worker never starts. All local and keyless. |
| `memory.semanticEnabled` | boolean | `false` | Enable the semantic (embedding) layer on top of lexical search. Turning it on triggers a one-time local model download (the selected `memory.embeddingModel`) and background embedding of the index. Runs in an Electron utilityProcess (transformers.js on onnxruntime-node; execution provider set by `memory.acceleration`); vector search via the sqlite-vec extension. Lexical FTS5 search works regardless; when the model or extension is unavailable, Smart search transparently falls back to lexical. |
| `memory.embeddingModel` | string | `'bge-base'` | Which local embedding model powers semantic search, chosen by quality in the Memory tab's "Search quality" dropdown. Options (see `src/shared/embedding-models.ts`), all from the bge-*-en-v1.5 family: `bge-small` (Balanced, 384d, ~34 MB), `bge-base` (Accurate, 768d, ~110 MB), `bge-large` (Best accuracy, 1024d, ~337 MB). All ONNX/q8, keyless, offline, CLS-pooled with the same retrieval query prefix - only size/dimensions/accuracy scale between tiers. The dropdown shows the quality word; the concrete model name + size + download state show in the status card below it. Switching re-embeds the index in the background; a dimension change (e.g. to `bge-large`) recreates the vector table. |
| `memory.acceleration` | `'auto' \| 'gpu' \| 'cpu'` | `'auto'` | Which hardware the embedding model runs on, set in the Memory tab's "Hardware acceleration" dropdown. `auto` (default) and `gpu` prefer a GPU execution provider (DirectML on Windows, WebGPU elsewhere) and fall back to CPU if it fails to initialize; `cpu` forces the universal path. Offloading to an idle GPU keeps the CPU free for the agents when many run at once. The active backend ("DirectML (GPU)", "CPU", ...) is shown in the status card. All local and keyless. |

Relevance filtering is automatic, with no user-facing threshold. These
sentence-embedding models are anisotropic: unrelated text does not score ~0, it
scores near a high, model-specific cosine baseline (bge sit around 0.6), so a raw
cosine threshold is neither portable across models nor legible to a user. Each
model instead declares an empirical `noiseFloor`, and the search filter rescales
raw cosine against it into a model-independent relevance (`(cos - floor) / (1 -
floor)`); a single internal cutoff then drops off-topic and gibberish hits on
every model while keeping genuine matches. Only the semantic layer is filtered;
lexical (keyword) hits always appear. Applied wherever semantic search runs:
Quick Find and `kangentic_search`.

Search mode is not a stored preference: the Quick Find palette auto-selects it
from `memory.semanticEnabled` (Smart/hybrid when on, keyword when off), so there
is no per-search toggle. The Memory tab also offers a "Rebuild index" action that
purges and re-runs the backfill sweep for the current project (recovery from a
stale or corrupt index).

### Mobile Bridge

The Mobile Devices tab hosts the desktop half of the mobile companion app's pairing/transport link (`src/main/mobile-bridge/`, see [Mobile Bridge](mobile-bridge.md)). Global-only (per-machine) - the identity, roster, and relay connection represent this desktop installation, not any one project.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mobileBridge.enabled` | boolean | `false` | Master switch. When `false`, no relay connection is held and pairing is unavailable; the relay Select and pairing controls are disabled in the UI. |
| `mobileBridge.relayMode` | `'hosted' \| 'local' \| 'custom'` | `'hosted'` | `'hosted'` always dials the Kangentic-hosted relay (`wss://relay.kangentic.com`), in every build. `'local'` dials `ws://127.0.0.1:8080` - a dev-only option, only offered by the Select in a dev build (see `src/shared/relay.ts`'s `LOCAL_DEV_RELAY_URL`). `'custom'` dials `relayUrl` instead, for self-hosters. |
| `mobileBridge.relayUrl` | string | `''` | The self-hosted relay to dial. Only consulted when `relayMode === 'custom'`; resolve the actual dial address through `resolveRelayUrl()` rather than reading this key directly - it normalizes the value and falls back to the hosted relay if this is empty or fails validation, so it never resolves to `''`. |

**Actions (not config keys):** the Mobile Devices tab also exposes two settings-registry entries that are UI surfaces, not `AppConfig` keys: **Pair a Device** (registry id `mobileBridge.pairing`) starts the QR pairing ceremony described in [Mobile Bridge](mobile-bridge.md#pairing-ceremony), and **Paired Devices** (registry id `mobileBridge.devices`) lists currently paired phones with their granted capabilities and a revoke action. Both are backed by the `mobile:*` IPC channels and the signed device roster (`src/main/mobile-bridge/roster-store.ts`), not persisted in `AppConfig`.

### Privacy

The Privacy tab is informational only. It displays what anonymous analytics Kangentic collects (app launches, platform, crash reports, task/session counts) and what it does not collect (task content, file paths, usernames, code). Analytics are powered by Aptabase (no cookies, no persistent identifiers, GDPR-compliant). Set `KANGENTIC_TELEMETRY=0` as an environment variable to opt out. It points to the Memory tab for the (fully local) conversation-search controls. Global-only (per-machine).

### Developer

Power-user settings for diagnosing the activity engine and other internal subsystems. Global-only (no per-project override). Also toggleable from anywhere via Ctrl+Shift+D.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `developer.activityDebugOverlay` | boolean | `false` | Show the floating activity-engine debug overlay. Renders live counters (pendingToolCount, subagentDepth, bg shells), the current `ActivityReason`, and a ring buffer of recent transitions for every running session in the current project. Polls `getActivityStats` every 2 seconds while open; lazy-disables the IPC when closed. With this on, the engine also writes a per-session JSON snapshot to `<projectRoot>/.kangentic/debug/<sessionId>.json` on every state change for post-mortem reads. |
| `developer.persistConsoleLogs` | boolean | `false` | Persist `info`, `debug`, and `log`-level console output to `<projectRoot>/.kangentic/logs/<YYYY-MM-DD>.log`. Errors and warnings are always persisted regardless of this toggle. NDJSON one file per day. Read via the `kangentic_tail_logs` MCP tool. |
| `developer.recordIpcTraffic` | boolean | `false` | Record IPC traffic to `<projectRoot>/.kangentic/logs/ipc-<YYYY-MM-DD>.jsonl`: inbound handler invocations (channel, args, result, durationMs, errors) plus outbound main-to-renderer pushes (the agent-driven board-invalidation events) tagged `direction: "out"`. Mutating channels (settings writes, MCP config, attachments) appear as `{ redacted: true, channel }` to keep secrets out of disk logs. Off by default - non-trivial disk impact when enabled. Read via `kangentic_get_ipc_log`. |
| `developer.previewInspectionServer` | boolean | dev: `true`, prod: `false` (UI absent in prod) | Bind a localhost-only HTTP inspection bridge that powers the dev-only `kangentic_devtools_*` MCP tools (screenshot, click, type, drag, query DOM, React fiber walker, console, engine + renderer state). Writes a per-worktree lockfile to `<projectRoot>/.kangentic/preview.lock` for cross-instance discovery. Bound to 127.0.0.1 on a random port; no auth (localhost is the boundary). UI affordance excluded from production builds entirely; the key persists in `AppConfig` for type compatibility but has no effect in shipped binaries. |
| `developer.previewEvalEnabled` | boolean | dev: `true`, prod: `false` (UI absent in prod) | Stricter gate on top of `previewInspectionServer`. Enables three high-risk inspection-bridge endpoints: `eval` (run any JavaScript in the renderer), `inject_session_event` (synthesize fake activity-engine events without spawning a real CLI), and `raw PTY input` (write any byte sequence directly to a session terminal, including control codes). Defaults ON in dev builds (mirrors `previewInspectionServer`) so the agent-driven workflow has these available on every `/preview` without a manual toggle; an explicit stored value still wins. Localhost-only and excluded from production builds entirely. |

## Swimlane-Level Configuration

Each swimlane has its own overrides (stored in the per-project DB):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string \| null | null | Free-form description of the column's purpose. Shown as a header tooltip and round-trips through `kangentic.json`. |
| `permission_mode` | PermissionMode \| null | null | Permission mode override for this column |
| `auto_spawn` | boolean | true | Whether moving a task here spawns an agent |
| `auto_command` | string \| null | null | Command injected into running session on task arrival |
| `plan_exit_target_id` | string \| null | null | Target column when plan-mode agent exits |
| `agent_override` | string \| null | null | Agent CLI override for sessions spawned in this column |
| `model_override` | string \| null | null | Adapter-specific model identifier passed at spawn time (e.g. Claude `--model opus`). Live-applied via `/model` slash on column transition when supported. |
| `effort_override` | string \| null | null | Adapter-specific effort/reasoning level passed at spawn time (e.g. Claude `--effort xhigh`). Live-applied via `/effort` slash on column transition when supported. |
| `handoff_context` | boolean | false | When enabled, cross-agent transitions package prior session context for the target agent |
| `session_target` | `'main'` \| `'isolated'` | `'main'` | Which session track a task runs on in this column. `main` = the task's shared main conversation; `isolated` = this column's own context-isolated session (keyed by the swimlane id). See `SessionTarget` in `src/shared/types.ts`. |
| `session_spawn_strategy` | `'create_or_resume'` \| `'always_spawn_new'` | `'create_or_resume'` | What to do with that session track on column entry. `create_or_resume` resumes the track's session if one exists, else spawns; `always_spawn_new` always spawns fresh, retiring the prior session. Default resolves context-aware (`resolveForceFresh`): isolated columns default to always-fresh. See `SessionSpawnStrategy`. |

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
      "description": "Agents actively work tasks here.",
      "icon": "square-terminal",
      "color": "#10b981",
      "autoSpawn": true,
      "permissionMode": "default",
      "autoCommand": null,
      "planExitTarget": null,
      "agentOverride": null,
      "modelOverride": null,
      "effortOverride": null,
      "handoffContext": false,
      "sessionTarget": "main",
      "sessionSpawnStrategy": "create_or_resume",
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
      "config": { "promptTemplate": "{{task_xml}}{{attachments}}" }
    }
  ],
  "transitions": [
    {
      "from": "*",
      "to": "uuid",
      "actions": ["uuid"]
    }
  ],
  "_modifiedBy": "device-id"
}
```

The `defaultBaseBranch` field sets the team-shared default base branch for worktree creation. When present, it takes precedence over the per-user `git.defaultBaseBranch` in `AppConfig`. Individual users can override it via `kangentic.local.json`.

The `_modifiedBy` field is auto-set by Kangentic to record which device last wrote the file (last-writer provenance) and should not be edited manually.

### Hand-Written Configs

Config files written by hand (without `id` fields on columns) are treated as additive only. Kangentic will create the specified columns but will not delete or ghost any existing columns. This allows safe experimentation without risking data loss.

## Permission Mode Resolution (Priority Order)

1. Task's `permission_mode` (if set) - set via the New Task dialog's Advanced section or the task-detail edit form; wins for the task's entire lifetime, column moves cannot change it
2. Swimlane's `permission_mode` (if set)
3. Global `config.agent.permissionMode`

## IPC

| Channel | Purpose |
|---------|---------|
| `config:get` | Get effective config (global + project merged) |
| `config:getGlobal` | Get global config only (no project overrides) |
| `config:set` | Update global config (partial merge) |
| `config:setSync` | Update global config synchronously (used on window close to persist the workspace layout) |
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
- `manual` → `acceptEdits` (removed as a separate mode)
- `project-settings` → `acceptEdits`

A parallel normalization runs on swimlane and session records in the DB. Note the swimlane normalization maps the removed `manual` and `project-settings` values to `default` rather than `acceptEdits` (see [Database - Migration Strategy](database.md#migration-strategy)).
