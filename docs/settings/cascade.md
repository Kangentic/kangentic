---
type: Reference
title: Configuration cascade
description: How a setting resolves from DEFAULT_CONFIG through the global config.json to the project .kangentic/config.json override, which keys are app-only or per-project, how a failed config write is reported, swimlane override fields, column automation types, permission mode order, and config IPC channels.
tags: [config, cascade, overrides, automations]
sources:
  - resource: src/main/config/config-manager.ts
  - resource: src/main/config/write-failure-notice.ts
  - resource: src/main/config/paths.ts
  - resource: src/main/safe-write.ts
  - resource: src/shared/types.ts
    title: Swimlane
  - resource: src/shared/automation-manifest.ts
    title: AUTOMATION_MANIFEST
---
# Configuration cascade

Kangentic uses a three-tier config resolution:

1. **Global defaults** (`DEFAULT_CONFIG` in `src/shared/types.ts`)
2. **Global user config** (`<configDir>/config.json`)
3. **Project overrides** (`<project>/.kangentic/config.json`)

Effective config = deep-merge(global defaults, user config, project overrides).

Main reads the global file once (`load()`) and a project's `.kangentic/config.json` once per
project: `getEffectiveConfig` serves a copy of the cached overrides after its first read, and
starts at most one background re-read a second (`PROJECT_OVERRIDES_REFRESH_MS`) to pick up a
hand edit or `ImportSourceStore`'s write to the same file. A change Kangentic saves is served at
once. The reason is main's thread: spawns, moves and PR sweeps read the file 14 times for one task
start and 9 times for a Done move (measured 2026-10-25), and under a disk load one synchronous read took
176 ms. A re-read that finds the file mid-edit (not JSON) keeps the last good overrides, and one
the disk refuses keeps them too; only a missing file drops them. `loadProjectOverrides` still
reads the file every time, because every read-modify-write of it (the Settings panel, the import
sources, a new project's seed) starts there.

The config directory (`<configDir>`) is platform-specific:

- **Windows:** `%APPDATA%/kangentic/`
- **macOS:** `~/Library/Application Support/kangentic/`
- **Linux:** `~/.config/kangentic/`

A config write that cannot reach disk (an unwritable data directory - a relocated userData on a
removable volume, say) never throws: `ConfigManager.save()` / `saveProjectOverrides()` route
through `safeWriteJson` (`src/main/safe-write.ts`) and return `false` rather than raise. The two
degrade differently. Global `save()` already updated its in-memory config before attempting the
write, so it keeps serving the change for the rest of the session even though the write failed.
`saveProjectOverrides()` puts only a write that landed in the cache: a failed project-override
write leaves `.kangentic/config.json` with its previous contents and drops the cached copy, so the
change is lost rather than merely unpersisted, and a later read serves the old value until a write
to that project succeeds.

The user is told about it twice, by two mechanisms that answer different questions.

The machine-level condition goes out once per failing write source via the `config:writeFailed`
push (below), latched in `src/main/config/write-failure-notice.ts` until a later write to that
source succeeds. Its message names the cause where the errno identifies one: a full disk, a
missing permission, a read-only volume, an unavailable drive, or, on Windows, a file in use or
read-only. The toast's title is "Change not saved to disk". An errno with no mapped cause falls back to the
plain "It may be lost on restart." body rather than guessing. The held-file case is a rename Windows refuses with EPERM, EACCES
or EBUSY while a file-sync client or scanner holds the target. A target with the read-only
attribute fails with the same EPERM, so the message names both causes. `safeWriteJson` retries that
rename twice, within 100 ms, before it gives up (Sentry DESKTOP-1Z). It never falls back to writing
straight onto the target, because a torn `config.json` reads as no overrides at all.

That notice is not enough on its own, because the busiest writer of source `config` is the 500 ms
window-bounds debounce, so it is usually spent on a window move. Every settings change afterwards
would be silent for the rest of the session. So `config:set`, `config:setProject` and
`config:setProjectByPath` also resolve `{ persisted }`, and the settings panel
(`AppSettingsPanel.tsx`) raises its own "This setting did not save" toast when a write the user
just asked for did not land. That check lives in the panel rather than the IPC handler because
those channels also carry window layouts, model caches and announcement dismissals, none of which
is a user gesture. It is collapsed per setting, keyed by the leaf dot-path it writes
(`git.initScript`), on a 60 second cooldown. The bucket has to be the leaf rather than the
top-level key, or a failed `git.worktreesEnabled` would silence `git.initScript` failing moments
later, which is the silence the per-setting bucket exists to remove.

One gesture can still be several writes, which is what the cooldown is for. Number fields commit
on every keystroke (typing `120` writes `1`, then `12`, then `120`), the Theme tab commits on
every arrow key, and the CLI path and remote-execution fields stay per-keystroke deliberately.
Settings TEXT fields do not: they use `SettingTextInput` (`settings/shared.tsx`), which commits on
blur, Enter, or unmount rather than per character. A settings write is not cheap - one `config:set`
is a synchronous whole-file write in main plus a `config:get` + `config:getGlobal` round trip plus
a runtime re-apply - so a 40-character path used to pay all of that 40 times.

## App-Only Settings

These settings appear only in App Settings and cannot be overridden per-project:

- `sidebarVisible`, `boardLayout`, `sidebar.width`
- `columnWidth`, `terminalPanelVisible`, `animationsEnabled`, `statusBarVisible`,
  `graphicsAccelerationEnabled`, `graphicsAccelerationOffBy`, `diffViewMode`
- `cardDensity`, `cardPreview`, `showTaskNumbers` (Task tab)
- `diffDefaultScope`, `diffIgnoreWhitespace`, `diffCollapseUnchanged`, `diffWrapLines`, `diffUseInlineWhenNarrow`, `diffFileSort`, `diffFlatList`
- `monitor` (the Agent Monitor's own toolbar controls, not a Settings-panel entry)
- `restoreWindowPosition`
- `agent.maxConcurrentSessions`, `agent.autoResumeSessionsOnRestart`
- `agent.executionServers` (per-agent remote-server url + auth; the Agent tab's Server URL / Authentication fields, shown when the selected agent declares remote-execution support)
- `agent.launchOptions` (per-agent boolean startup toggles; the Agent tab's Launch Options rows, shown when the selected agent declares launch-option capability)
- `terminal.*` (shell, font size, font family, cursor style, panel height, show preview, colors - the whole namespace is global-only)
- `autoFocusIdleSession`
- `stopLeftoverProcesses`
- `skipBoardConfigConfirm`
- `windowLightDismiss`
- `contextBar.*` (all context bar visibility toggles; Task tab)
- `notifications.*` (all notification settings)
- `agent.pauseIdleAgentsOnLowMemory`, `agent.idleTimeoutEnabled`, `agent.idleTimeoutMinutes` (the Pausing agents card, in the Performance tab)
- `developer.activityDebugOverlay`, `developer.persistConsoleLogs`, `developer.recordIpcTraffic`, `developer.previewInspectionServer`, `developer.previewEvalEnabled`, `developer.stallProfiler`
- `browserAutomation.enabled`, `browserAutomation.allowInteraction`, `browserAutomation.allowNavigation`, `browserAutomation.allowEval`, `browserAutomation.restrictNavigationToLocalhost`
- `automation.agent`, `automation.model`, `automation.effort` (the Automation agent that answers Agent evaluations and names tasks and Command Terminals, in the Workflows tab; see [Automation agent](../architecture/automations/automation-agent.md))
- `workflows.agent`, `workflows.model`, `workflows.effort` (the Workflow agent every workflow's own agent runs on, in the Workflows tab; required before one starts)
- `workflows.agentPrompt` (the workflow agent's first message, in the Workflows tab)
- `workflows.agentPaneWidth` (the Workflows view's agent pane width; set by dragging the pane's edge, not in Settings)
- `dictation.*` (all voice dictation settings)
- `knowledgeGraph.*` (conversation search + recall, in the Knowledge Graph tab, id `knowledgeGraph`)
- `mobileBridge.*` (mobile companion app pairing/relay, in the Mobile Devices tab)
- `devServer.*` (dev-server port reservation range; global-only because the ledger is machine-wide, and not exposed in Settings UI)
- `hotkeyOverrides`

## Per-Project Overridable Settings

These settings appear in both App Settings (as defaults) and Project Settings (as overrides):

- `theme`, `themeFollowsSystem`, `themeLight`, `themeDark` (the Theme tab; the four travel together)
- `agent.permissionMode`
- `git.worktreesEnabled`, `git.autoCleanup`, `git.defaultBaseBranch`, `git.copyFiles`, `git.initScript`, `git.linkNodeModules`, `git.prAutoRefresh`, `git.autoFetch`, `git.prBypassCountsAsReady`
- `browser.enabled`, `browser.defaultUrl`
- `agent.execution` (per-agent local/remote mode + server working directory; editable inline in the Agent tab for the currently-selected agent, but NOT seeded into new projects - see below)

`agent.cliPaths` is per project with no App Settings default to edit: the Agent tab's CLI path row writes only the project's own file. A project that has no paths of its own is given the global ones once, the first time its overrides load (`loadProjectOverrides()`), which carries a path set before the scope moved; after that no run reads the global value for a project.

> **Seeded vs. stored.** All settings above are stored per-project in `.kangentic/config.json` and editable in Project Settings. When a *new* project is created it is seeded with only the Theme tab's four keys (`theme`, `themeFollowsSystem`, `themeLight`, `themeDark`), `agent.permissionMode`, and `git.*` (via `pickOverridableSubset` in `config-manager.ts`). `loadProjectOverrides()` also renames the product pair's retired theme ids (`kangentic-light` / `kangentic-dark`, which existed briefly before the pair was named `clay` / `rust`) the first time a project loads, as `load()` does for the global file. `browser.*`, `agent.execution`, and non-setting project data such as `importSources`, are kept per-project and never cloned, so one project's dev-server URL, remote-server directory, or import sources cannot leak into another. `terminal.*` used to be seeded here too; it moved to global-only, and `loadProjectOverrides()` (`config-manager.ts`) one-time-migrates any pre-existing per-project `terminal.{shell,fontFamily,fontSize,scrollbackLines,cursorStyle}` out of `.kangentic/config.json` (dropped, not promoted to global) the first time that project loads, along with `terminal.backspaceSendsCtrlH`, the key of the removed "Word delete on Backspace" setting. `load()` drops that removed key and `scrollbackLines` from the global `config.json` the same way.

## Swimlane-Level Configuration

Each swimlane has its own overrides (stored in the per-project DB):

> This table covers the automation and behavior overrides only. A column's identity fields on
> `BoardColumnConfig` (`id`, `name`, `role`, `icon`, `color`, `archived`) are not listed here:
> they are set in the Board Manager UI and round-trip through `kangentic.json`. See
> [Board Configuration](board-config.md#board-configuration).
>
> `role` is the one identity field with a closed set of values: `todo`, `done`, or omitted. A
> hand-edited `kangentic.json` naming anything else is treated as a custom column and raises a
> reconciliation warning naming that column: a toast and a board banner when the edit is applied to
> an open project, console-only for a role already present at project open. An explicit
> `"role": null` is simply a custom column and warns about nothing. See
> [Board tables](../database/board-tables.md#swimlanes-table) for the full validation chain.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string \| null | null | Free-form description of the column's purpose. Shown as a header tooltip and round-trips through `kangentic.json`. |
| `permission_mode` | PermissionMode \| null | null | Permission mode override for this column |
| `auto_spawn` | boolean | true | Whether moving a task here spawns an agent |
| `auto_command` | string \| null | null | RETIRED. The column's message to its agent is a `send_message` automation now, in `column_automations`. The migration moved every existing value into one and nulled this field; nothing reads it. See [Column automations](#column-automations). |
| `auto_command_mode` | `'immediate'` \| `'deferred'` | `'immediate'` | RETIRED with `auto_command`, and reset by the same migration. The delivery choice is the `send_message` automation's own `mode` field. |
| `plan_exit_target_id` | string \| null | null | Target column when plan-mode agent exits |
| `plan_approval` | `'automatic'` \| `'manual'` | `'manual'` | Who approves a plan made in this column, read only while `permission_mode` is `plan`. `manual` waits for the user in the agent's terminal; `automatic` has Kangentic approve it, for an agent that declares `supportsPlanAutoApproval`, so the task moves on by itself, and while it plans, an MCP tool the allow rules in the project's or the user's Claude settings name runs without a prompt (Kangentic's own excluded). A question the agent asks the user still waits. A workflow task follows its own value instead, else the plan columns on its route, and a task with its automations disabled is always Manual. See [transition-engine.md](../architecture/automations/transition-engine.md#plan_exit_target_id). |
| `agent_override` | string \| null | null | Agent CLI override for sessions spawned in this column |
| `model_override` | string \| null | null | Adapter-specific model identifier passed at spawn time (e.g. Claude `--model opus`), stored exactly as written. A column transition into a different concrete model restarts a live session with the new flag. |
| `effort_override` | string \| null | null | Adapter-specific effort/reasoning level passed at spawn time (e.g. Claude `--effort xhigh`). A column transition into a different concrete effort restarts a live session with the new flag. |
| `handoff_context` | boolean | false | When enabled, cross-agent transitions package prior session context for the target agent |
| `session_target` | `'main'` \| `'isolated'` | `'main'` | Which session track a task runs on in this column. `main` = the task's shared main conversation; `isolated` = this column's own context-isolated session (keyed by the swimlane id). See `SessionTarget` in `src/shared/types.ts`. |
| `session_spawn_strategy` | `'create_or_resume'` \| `'always_spawn_new'` | `'create_or_resume'` | What to do with that session track on column entry. `create_or_resume` resumes the track's session if one exists, else spawns; `always_spawn_new` always spawns fresh, retiring the prior session. The isolated-means-fresh pairing is applied by the WRITERS, not by `resolveForceFresh`: this column is NOT NULL with a literal default, so the resolver's context-aware fallback never fires for a stored column. In the Column Manager and over MCP, setting `sessionTarget` to `isolated` carries this to `always_spawn_new` (and back), via `snapSpawnStrategyToTarget`. **Editing this file by hand does not**: `apply-config.ts` applies each key as written, so name both keys or an isolated column resumes one long session instead of running a fresh pass per entry. See `SessionSpawnStrategy`. |

## Column automations

What a column does when a task enters it, each time its agent finishes a turn there, and when the
task leaves. Each column owns one ordered list, split into three groups, **On task enter**, **On
agent turn end** and **On task exit**, and each row has its own switch. They are edited in the
**Column Manager** (click a column header on the board), and they round-trip through
`kangentic.json` under the column that owns them.

Five types ship. Each is an adapter under `src/main/automations/adapters/`, declared once in
`AUTOMATION_MANIFEST`, which is also what the editor renders its fields from.

| Type | What it does | Fields |
|------|--------------|--------|
| `send_message` | Types a message at the column's agent. On every trigger, a message with more than one line is pasted whole, unless it starts with `/` (a slash command is always typed, so it runs) | `message`, `mode` (`immediate` \| `deferred`) |
| `run_script` | Runs a script in the task's worktree, or the project checkout when it has none | `script`, `timeoutMinutes` (default 10, range 1 to 120, file only) |
| `webhook` | Calls a URL, retrying a transport error, 408, 429 or 5xx, for up to 3 attempts in total | `url`, `method`, `body`, `headers` |
| `notify` | Notifies the user on the desktop and every paired phone | `title`, `body` |
| `move_to_column` | Moves the task to another column, and hands the agent there a message. On agent turn end only; a row that runs ends its group | `targetColumn` (a column name; absent means the next column), `message` |

**On agent turn end** runs when the agent working the task finishes a turn on its own (not an
interrupt, a failed turn, or a background job still running), once the turn has settled. Only a
turn that began after the task entered the column counts. A plan approval starts the turn again,
because the agent implements in the turn that planned, so a plan approved after the task arrived
counts, whether the approval moved the task (an `auto-move` entry) or someone dragged it in first.
So does a drag from a column into its plan exit target, when the agent had already left plan mode
by then. A turn that is dropped records each pending row as skipped, once per visit, and the next
turn end still runs the rows. See [transition-engine.md](../architecture/automations/transition-engine.md). Rows run top to bottom, each at most
once per visit, and only a row that actually runs counts: a row whose Condition answered no is
checked again at the next turn end. To Do and Done have no turn ends, nor does a column whose agent
is off or does not report turn ends (agents whose only signal is terminal silence).

**Condition and Frequency apply to every type.** A row's **Condition** is one of two kinds. An
**Agent evaluation** is a sentence in plain words ("the review found work the implementer can do"),
answered yes or no by the **Automation agent** (Settings > Workflows) before the row runs, with a
one-line reason the run log keeps. One headless, read-only call answers every pending Agent
evaluation of a group at once; at a turn end it reads the task and the agent's final message, on
enter or exit the task and the move. Until an Automation agent is set up, a row with an Agent
evaluation is skipped (a Condition written earlier is kept). A **Text match** (`finalLine`) is
checked in code against the agent's last line at a turn end, needs no Automation agent and makes no
call; see [Condition and Frequency](../architecture/automations/triggers.md#condition-and-frequency). A row's
**Frequency** is the most times it may run on one task, counted across every visit; a row past it
is skipped. The count starts over when a person moves the task to another column and when the task
leaves Done, so a task sent back for another pass, or a reopened one, can loop and advance again.
The board's own moves (an agent's, a Move to column row's, a workflow's) keep the count. Both are
off on every row unless set, so a board from before them runs as it did.

The Code Review loop is two `move_to_column` rows on a review column's On agent turn end: "Back for
revisions" to Executing with the reviewer's `{{agentReply}}` in its message, behind a Condition and
a Frequency, and "Clean" to the next column behind its own Condition.

A sixth, `spawn_agent`, is legacy: it survives on boards that already had a `spawn_agent` row
carrying a custom prompt, and cannot be created. `kill_session`, `create_worktree` and
`cleanup_worktree` are gone entirely, rows and all, because each was a no-op or a duplicate of
what the move path already does.

`send_command` is accepted on read as an alias for `send_message`, and its `command` field as an
alias for `message`, so a hand-written file that predates the rename still opens. Neither alias is
written back.

A name is required and unique within its column, ignoring case. That is enforced by a unique
index in the schema, not only by the editor, so a hand-edited file or an MCP write cannot break
it.

Every text field takes the template variables listed in
[transition-engine.md](../architecture/automations/transition-engine.md), which is also where the per-field escaping and the
`KANGENTIC_*` environment variables a script receives are documented.

## Permission Mode Resolution (Priority Order)

1. Task's `permission_mode` (if set) - set via the New Task dialog's Advanced section or the task-detail edit form; wins for the task's entire lifetime, column moves cannot change it
2. Swimlane's `permission_mode` (if set)
3. Global `config.agent.permissionMode`

Valid values: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto` (`PermissionMode` in `src/shared/types.ts`). What each one passes to Claude is listed under [agent.*](app-config.md#agent), and the dropdown offers only the modes the selected agent supports.

## IPC

| Channel | Purpose |
|---------|---------|
| `config:get` | Get effective config (global + project merged) |
| `config:getGlobal` | Get global config only (no project overrides) |
| `config:set` | Update global config (partial merge); resolves `{ persisted }` |
| `config:setSync` | Update global config synchronously (used on window close to persist the workspace layout) |
| `config:getProject` | Get project-level overrides for current project |
| `config:setProject` | Update project-level overrides for current project; resolves `{ persisted }` |
| `config:getProjectByPath` | Get project-level overrides by project path |
| `config:setProjectByPath` | Update project-level overrides by project path; resolves `{ persisted }` |
| `config:syncDefaultToProjects` | Sync changed default values to all existing projects (deep merge) |
| `config:changed` | Event: fanned to every window (main and open pop-outs) after any `config:set` is applied; subscribers re-fetch via `config:get`, so theme and settings stay in sync across windows |
| `config:writeFailed` | Event: a synchronous write to config or another small per-machine/per-project state file failed; carries the message to toast, naming the cause where the errno gives one, at most once per failing source until a later write to that source succeeds |
| `boardConfig:exists` | Check if `kangentic.json` exists for the active project |
| `boardConfig:export` | Export current board state to `kangentic.json` (auto-runs on project open) |
| `boardConfig:apply` | Apply pending config file changes (reconcile file into DB) |
| `boardConfig:changed` | Event: `kangentic.json` or `kangentic.local.json` changed on disk |
| `boardConfig:warnings` | Event: the project-open reconcile's warnings, shown in the board's warning banner |
| `boardConfig:getLastWarnings` | The warnings of a project's last apply, fetched when a project becomes current |
| `boardConfig:getBoardProfiles` | Get the board's [Board Profiles](board-config.md#board-profiles) |
| `boardConfig:setBoardProfiles` | Replace the board's Board Profiles (team-scoped) |
| `boardConfig:boardProfilesChanged` | Event: an agent (MCP) rewrote this project's Board Profiles |
| `boardConfig:getShortcuts` | Get task detail dialog [shortcuts](board-config.md#shortcuts) |
| `boardConfig:setShortcuts` | Update task detail dialog shortcuts |
| `boardConfig:shortcutsChanged` | Event: shortcuts file changed |
| `boardConfig:setDefaultBaseBranch` | Update the default base branch in `kangentic.json` |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `KANGENTIC_DATA_DIR` | Override the config/data directory path |
| `KANGENTIC_ANNOUNCEMENTS_URL` | Override the announcements feed URL (for testing against a local fixture) |

## Legacy Migration

On load, the ConfigManager auto-migrates legacy permission mode values:

- `dangerously-skip` → `bypassPermissions`
- `bypass-permissions` → `bypassPermissions`
- `manual` → `acceptEdits` (removed as a separate mode)
- `project-settings` → `acceptEdits`

A parallel normalization runs on swimlane and session records in the DB. Note the swimlane normalization maps the removed `manual` and `project-settings` values to `default` rather than `acceptEdits` (see [Migration Strategy](../database/migrations.md)).
