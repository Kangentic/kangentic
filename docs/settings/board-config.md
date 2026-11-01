---
type: Reference
title: Board config files
description: How kangentic.json and kangentic.local.json define the shared board, which way each sync runs, how a hand edit ghosts or deletes a column, the file schema with its onEnter, onTurnEnd and onExit arrays, which bad rows are skipped, and where Shortcuts and Board Profiles are stored.
tags: [board, kangentic-json, sync, profiles, shortcuts]
sources:
  - resource: src/main/config/board-config/
  - resource: src/main/config/board-config-manager.ts
  - resource: src/shared/types.ts
    title: BoardConfig, BoardColumnConfig, BoardProfile
  - resource: src/shared/template-vars.ts
    title: ShortcutContext, resolveShortcutCommand
---
# Board config files

## Shortcuts

Shortcuts are custom command buttons displayed in the task detail dialog header and kebab menu. They are configured in the Shortcuts settings tab (not stored in `AppConfig`). Shortcut definitions are saved in the board config files:

- **Team shortcuts** in `kangentic.json` (committed, shared)
- **Personal shortcuts** in `kangentic.local.json` (gitignored, local-only)

Each shortcut has a label, Lucide icon name, shell command, and display location (header, menu, or both).

Template variables available in shortcut commands (defined in `src/shared/template-vars.ts`):

| Variable | Value |
|----------|-------|
| `{{cwd}}` | Working directory (worktree path or project path) |
| `{{branchName}}` | Git branch name (shell-sanitized: git allows `;`, `$`, `&` and backticks in a ref name) |
| `{{taskTitle}}` | Task title (shell-sanitized to prevent injection) |
| `{{projectPath}}` | Project root directory path |

IPC channels for shortcuts are in the Board Config group: `boardConfig:getShortcuts`, `boardConfig:setShortcuts`, `boardConfig:shortcutsChanged`.

## Board Profiles

A **Board Profile** is a named alternate set of per-column strategy settings (agent, model, effort,
permission mode, auto-command, auto-command mode, auto-spawn, handoff context, session target,
session spawn strategy, plan-exit target). A task selects one and rides its ladder as it moves - so one task can run Planning
in Opus xhigh and Merge in Sonnet high while another runs the same board more cheaply. Column
*identity* (which columns exist, their name, order, role, color, icon) is singular across profiles;
only strategy is profile-scoped. Plan approval is not part of a profile either: it is the column's
own, every profile shares it, and the Column Manager disables it while a profile is selected.

Profiles are authored in the Column Manager and stored under a `profiles` key in
`kangentic.json`. Unlike shortcuts they are **team-only** - never `kangentic.local.json` - because
`tasks.profile_id` is resolved on every machine that opens the board, so a personal-only profile
would leave teammates with tasks pointing at an id they cannot resolve. Boards with no profiles omit
the key entirely. A profile may also carry an optional `description` string.

```json
"profiles": [
  {
    "id": "6f3d9c21-...",
    "name": "Heavy",
    "description": "Opus for planning, Sonnet for review",
    "columns": {
      "<swimlane-uuid>": { "modelOverride": "opus", "effortOverride": "xhigh" },
      "<swimlane-uuid>": { "modelOverride": null }
    }
  }
]
```

Entries are keyed by **swimlane uuid** (a rename must not detach in-flight tasks) and are **sparse**,
with three distinct states per setting:

| Form | Meaning |
|------|---------|
| key omitted | Inherit the column's own setting |
| key set to `null` | Clear to the agent default, overriding the column's own pin |
| key set to a value | Use that value in this column |

That third state is why the resolver (`src/main/transition-engine/column-strategy.ts`) branches on
key *presence* and never `??`: under `??`, "run the agent default here even though the column pins
one" is indistinguishable from "inherit", and a profile could only ever add pins, never remove them.

A task's assignment lives in the per-project database (`tasks.profile_id`), not in config: the
profile *definition* is team-shared, the *assignment* is per-task local runtime state. A task
pointing at a profile a teammate deleted degrades to the columns' own settings and logs once. The
same is true of `tasks.run_mode`, which records which of the dialog's two branches the task is on
(see [tasks table](../database/board-tables.md#tasks-table)).

Profiles are mutually exclusive with the task's Advanced agent/model/effort/permission pins and with
`run_mode: 'agent_override'`, enforced at write time in `TaskRepository`.

IPC channels are in the Board Config group: `boardConfig:getBoardProfiles`,
`boardConfig:setBoardProfiles`, `boardConfig:boardProfilesChanged`. Agents can read and edit
profiles (including across projects) via the `kangentic_*_board_profile` MCP tools - see
[Board Profiles](../integrations/mcp-server/profile-tools.md#board-profiles).

## Board Configuration

Kangentic supports shareable board configuration via JSON files in the project root. This lets teams commit their column layout, colors, icons, actions, and transitions to version control so everyone works with the same board structure.

### Two-File System

- **`kangentic.json`** -- the team file. Committed to git and shared with all collaborators. Contains the canonical board layout.
- **`kangentic.local.json`** -- the personal overrides file. Auto-added to `.gitignore`. Contains per-user customizations (colors, icons, extra columns) that merge on top of the team file.

When both files exist, `kangentic.local.json` is merged over `kangentic.json` by matching columns by ID. Unmatched local entries are appended. A column's automations merge as a WHOLE list, not row by row: a local column that declares `automations` replaces the team file's list for that column outright, because an ordered list has no stable key to merge a row against once names can change.

### Board Config Sync (kangentic.json)

**The sync is bidirectional, and the two directions do not fire on the same events.** Getting
this backwards is the single easiest mistake to make here, so it is spelled out before the
mechanics: editing `kangentic.json` by hand IS a real way to change the board, and it is a
*different* removal path from the UI or MCP with *different* rules.

**Database -> file (export).** Unconditional and automatic. Every swimlane, action, and
transition mutation triggers a debounced write-back, and opening a project writes one too, so the
team always has a current file to commit. If the file already matches the DB state, no write
occurs.

**File -> database (apply).** Gated, but it happens more often than the banner suggests:

1. **On project open**, if `kangentic.json` exists, Kangentic applies it to the database
   **before** the export above. On a conflict the file wins. There is no banner and no prompt on
   this path.
2. **On an external edit while the project is open**, the file watcher raises a reconciliation
   banner (or applies silently when `skipBoardConfigConfirm` is set).

The open-time apply is why a hand-edited `kangentic.json` sticks: the app is not merely writing
to the file, it reads it back as the source of truth for column identity every time the project
loads. It is also why a column deleted through the UI or `kangentic_delete_column` must update
the file in the same operation. If it did not, the next open would re-create the column from the
stale file entry, reusing its original UUID, with nothing logged.

**Removing a column by editing the file is softer than deleting it.** The DB, MCP, and UI paths
all *refuse* to delete a column that still holds tasks. The file path does not: it **ghosts** a
non-empty column instead (see Reconciliation below) and hard-deletes an empty one. Pick the file
path when you want a column retired without first emptying it.

**But the file path does not clean up Board Profiles.** Deleting a column through the UI or
`kangentic_delete_column` also prunes that column out of every profile: the uuid-keyed entry in
`profiles[].columns`, and any `planExitTarget` naming it. (If `kangentic.json` cannot be read, the
delete still succeeds and the prune is skipped and logged, so the entries stay until the file is
fixed.) Removing the column by hand-editing the
file (or letting an emptied ghost be reaped) does not - those entries are left pointing at a
column that no longer exists. They are inert rather than harmful - strategy resolution looks an
entry up by the *live* column's uuid, so a key no column has is simply never read - but they
accumulate, and a hand-editor reading the file will wonder. The asymmetry is
deliberate: the serializer cannot tell a *deleted* column apart from one a teammate has and you
do not, and it preserves the latter on purpose. If you retire a column by editing the file, drop
its `profiles[].columns` entries in the same edit.

**Two gotchas worth knowing:**

- A hand-written config whose columns carry **no `id` fields is additive only** - it can add and
  update columns but never removes one. Removal requires at least one config column with an `id`.
  Write-back then serializes the real UUIDs for future reconciliation.
- If `kangentic.json` is **unparseable or invalid**, the apply is skipped and the file is **left as
  it is**. The board loads from the database, a warning says why, and every write to the file is
  skipped or refused until it is fixed (see the unreadable-file rules at the end of [File Structure](#file-structure) below). Fixing the file and
  saving it applies it over whatever the database picked up meanwhile. Two exceptions write over
  a file that holds no board: an empty file, and the `"columns": []` stub a settings save creates
  on a project that had no `kangentic.json`.

### File Watching and Reconciliation

Kangentic watches both `kangentic.json` and `kangentic.local.json` for changes. When a change is detected (e.g., a teammate pulls a new version), a reconciliation banner appears in the UI. The user can apply the changes or dismiss the banner. If `skipBoardConfigConfirm` is enabled, changes are applied automatically without the banner.

The same matching rules below also run unprompted on project open, per the sync section above.

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
      "planExitTarget": null,
      "agentOverride": null,
      "modelOverride": null,
      "effortOverride": null,
      "handoffContext": false,
      "sessionTarget": "main",
      "sessionSpawnStrategy": "create_or_resume",
      "archived": false,
      "automations": {
        "onEnter": [
          { "name": "Review", "type": "send_message", "message": "/code-review {{baseBranch}}" },
          { "name": "Ping the channel", "type": "webhook", "url": "https://hooks.example.com/abc" }
        ],
        "onTurnEnd": [
          {
            "name": "Back for revisions",
            "type": "move_to_column",
            "targetColumn": "Executing",
            "message": "Back from {{column}}. What the review found:\n{{agentReply}}",
            "finalLine": "Verdict: Blocked",
            "maxRuns": 3
          },
          { "name": "Clean", "type": "move_to_column", "condition": "The review is clean" }
        ],
        "onExit": [
          { "name": "Archive the log", "type": "run_script", "enabled": false, "script": "scripts/archive.sh" }
        ]
      }
    }
  ],
  "defaultBaseBranch": "main",
  "shortcuts": [],
  "profiles": [
    {
      "id": "uuid",
      "name": "Heavy",
      "columns": {
        "<swimlane-uuid>": { "modelOverride": "opus", "effortOverride": "xhigh" }
      }
    }
  ],
  "_modifiedBy": "device-id"
}
```

**A `modelOverride` is the value the agent CLI receives.** A floating alias (`"opus"`) runs the
latest release of that family, so a committed column moves to each new version with no edit; a
full id (`"claude-opus-5-5"`) stays pinned for a column that needs a fixed model. A value is
stored exactly as written, because the file does not know which agent a column runs. A
hand-written friendly Claude name (`"Opus"`, `"Opus 5.5"`) still works: the Claude adapter
converts it to Claude's spelling (`opus`, `claude-opus-5-5`) when it builds `--model`, and no
other agent ever sees that conversion. A single word converts only when Claude's own `/model`
picker has listed that family, so a gateway model named `"Workhorse"` reaches the CLI as written;
before the first picker scan on a machine, write the alias in lowercase. What an alias means is
decided by the CLI on each machine: the provider and variables such as
`ANTHROPIC_DEFAULT_OPUS_MODEL` can point it at a different version.

**`planApproval` is written only when it is `"automatic"`** (`"planApproval": "automatic"` on a
column whose `permissionMode` is `"plan"`). The export omits it at `"manual"`, and
the apply reads an absent key as Manual rather than keeping the database's value. That is
deliberate: a teammate who turns Automatic off removes the key, and keeping the old value would
leave plans approving on every other machine. To Do and Done always apply as Manual. A Board Profile
cannot change it.

**Automations nest under the column that owns them, as three named arrays** (`onEnter`,
`onTurnEnd`, `onExit`). Array order IS the run order within its group, an empty group is an absent
key, and the type's own fields sit flat on the row beside `name`, `type`, `enabled`, `condition`,
`finalLine` and `maxRuns` rather than under a `with` object. Those six keys are reserved:
`automation-manifest-reserved-keys.test.ts` fails an adapter that declares a field colliding with
one, which is what keeps the flat shape safe as the reserved set grows.

`enabled` is omitted when true, so a switched-off row is the only one that carries it; `condition`,
`finalLine` and `maxRuns` are omitted when off. There is no `on` key, because the array a row sits
in already says which trigger it runs on. A `move_to_column` row names its column by name, as
`planExitTarget` does, and renaming that column rewrites the row.

**A row's Condition is one of two kinds.** `condition` is plain words the Automation agent judges in
a headless call. `finalLine` is a Text match, checked in code against the last line of the agent's final message that has a word in it (a
closing code fence or rule is skipped), with no call: the pattern must cover the whole line, `*`
matches any text, and case, punctuation (markdown marks included), invisible characters such as a
zero-width space, and extra spaces are ignored, so `"Verdict: Ready"` matches
`**Verdict: Ready.**`. A Text match needs a final message, so it works in `onTurnEnd` only. A row carries one of the two keys, never both.

**Keys this build does not know are kept.** When the export rebuilds a column's `automations`, it
carries over any automation list, row type, or row key it does not recognize from the file it last
read (a row is matched by name and type). So a field or trigger that a NEWER build added survives a
save by this one. The reverse cannot be fixed from here: a build from before On agent turn end
ignores `onTurnEnd`, `condition` and `maxRuns`, drops those rows from its database, and its next
export writes the file without them. A build from before Text match is worse for a row that uses
one: it ignores `finalLine` and keeps the row, so a Move to column guarded by a Text match runs on
that build as an unguarded move, at every turn end. **A team that shares `kangentic.json` should
update Kangentic together, and restart every running copy onto the new build before applying a
file that adds `finalLine`.**

**The top-level `actions` and `transitions` arrays are gone, along with `columns[].autoCommand`
and `columns[].autoCommandMode`.** All four are still READ, and converted on apply by the same
rules the one-time migration used, so an older file still opens. None of them is written any
more. The first save after upgrading therefore rewrites `kangentic.json` and drops them, which
is a real diff in a tracked file: see the release notes.

A bad automation never fails the whole file. Nothing validates automations before apply; the
reader in `apply-automations.ts` reports each problem as a warning and applies the rest of the
board:

- A row that is not an object, has no name, or has a `type` outside the registry is skipped.
- A RETIRED type (`kill_session`, `create_worktree`, `cleanup_worktree`) is skipped, matching
  what the migration did to the same row in the database.
- A row filed under a trigger its type does not run on (a `move_to_column` row in `onEnter` or
  `onExit`) is skipped: it would run inside the move that fired it.
- A `maxRuns` below 1 or not a number reads as off, and a fraction is rounded down. Each one warns,
  since the MCP writer refuses all three. A blank `condition` or `finalLine` reads as off with no
  warning.
- A `finalLine` that is not text, or one on a row in `onEnter` or `onExit`, reads as off with a
  warning; the row still runs. A row with both a `condition` and a `finalLine` keeps the
  `finalLine`, with a warning. A `finalLine` with no letter, number or `*` is kept, with a
  warning: no last line can match it, so the row never runs.
- A second row with a name already used in the same column is renamed (`Notify 2`).
- An `automations` value that is not an object, or an `onEnter` / `onTurnEnd` / `onExit` that is not a list
  (`{}`, or a single row written without brackets), keeps that column's current automations
  untouched. Treating it as empty would delete the column's rows, and on project open the export
  that follows would write the deletion into the file. A malformed value also does not count as
  the file knowing the `automations` key, so it cannot clear the columns the file is silent about.

On project open these warnings appear in the board's warning banner (`boardConfig:warnings`). When a
`kangentic.json` change is applied while the app is running, each one is shown as a toast, and an
apply that fails outright shows one error toast instead of an unhandled rejection.

A file that exists but is not valid JSON, such as one holding git merge conflict markers, is never
overwritten. The board loads from the local database with a warning, and nothing writes to the
file until it is fixed. The open-time export and the write-back after a board edit are skipped and
logged. A profile, shortcut, or base branch save is refused with an error the user sees (a toast,
or an MCP command's error), so the change is never reported as saved. Board edits made meanwhile
stay in the local database, and the fixed file applies over them when it changes on disk. An
unreadable `kangentic.local.json` is reported the same way and the team file applies without it.

Three cases are not a broken file. An empty file reads as missing and the next write re-creates
it. A leading UTF-8 byte order mark, which Windows editors save, is ignored. A read that a Windows
lock refuses (`EBUSY`, `EPERM`) is retried by the write-back a few times before it gives up. The
export also skips a valid file the validator rejects, except a stub with no columns, which a
settings save writes on a project that had no `kangentic.json`.

The file's own lists are stricter. A `columns`, `actions`, or `transitions` value that is not a
list, an entry in one that is not an object, a column with no name, or a transition whose
`actions` is not a list rejects the whole file, and the board loads from the local database. In
`kangentic.local.json`, any of those values that is not a list is ignored instead, and so is any
entry that is not an object. A `shortcuts` or `profiles` value that is not a list reads as none.

The `defaultBaseBranch` field sets the team-shared default base branch for worktree creation. When present, it takes precedence over the per-user `git.defaultBaseBranch` in `AppConfig`. Individual users can override it via `kangentic.local.json`.

The `_modifiedBy` field is auto-set by Kangentic to record which device last wrote the file (last-writer provenance) and should not be edited manually.

### Hand-Written Configs

Config files written by hand (without `id` fields on columns) are treated as additive only. Kangentic will create the specified columns but will not delete or ghost any existing columns. This allows safe experimentation without risking data loss.
