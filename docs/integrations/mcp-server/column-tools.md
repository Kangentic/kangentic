---
type: Reference
title: Column tools
description: "Reading and editing board columns over MCP: list_columns and get_column_detail output, update_column and create_column parameters (autoSpawn, session track, planApproval, model and effort overrides), the cross-project no-reconcile rule, and what delete_column refuses."
tags: [mcp, columns, board]
sources:
  - resource: src/main/agent/mcp-http/task-tools.ts
    title: Column tool registrations
  - resource: src/main/agent/commands/column-commands.ts
  - resource: src/main/agent/commands/inventory-commands.ts
  - resource: src/main/agent/commands/analytics-commands.ts
  - resource: src/main/agent/commands/column-enums.ts
  - resource: src/main/agent/commands/column-resolver.ts
---
# Column tools

## kangentic_list_columns

List every column on the board, in board order, with names, roles, and task counts.

No parameters beyond the optional `project` selector.

**The done-role column is included, and it is the one an agent most needs.** It reports a completed
count rather than a live task count, because moving a task there archives it off the board, so its
live count is structurally zero. Read the roles rather than assuming the last column in the list is
the finish line: on the default board the last non-done column is Merge, which auto-spawns
`/merge-pull-request`.

A column a *user* archived deliberately stays hidden. The carve-out is the `done` role alone, not
"any archived column".

A column that runs tasks on its own conversation is tagged `[isolated session]`. Only those are
marked: a main-session column is the norm, and tagging every one would bury the distinction. See
[kangentic_update_column](#kangentic_update_column) for what the tag means.

## kangentic_get_column_detail

Get detailed column configuration: description, auto-spawn, permission mode, session track, plan approval, plan exit target, and visual settings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name (case-insensitive) |

`Session`, `On enter`, `Handoff context`, and `Plan approval` always print, even at their defaults.
The overrides below them print only when set, because "no override" is the absence of a value; a
session track is never absent, so hiding the default would leave a caller unable to tell a
main-session column from a failed write. `Plan approval` reads `Plan approval: manual` or
`Plan approval: automatic`, with `(applies only while permission mode is plan)` after it on a
column that is not in plan mode, and `data.planApproval` carries the value. `Auto-command timing`
is the one middle case: it prints only alongside an
`autoCommand`, since it does nothing without one.

Also returns `taskOrder`: the column's tasks top to bottom, each with its `position` (the
zero-based ordinal slot described under [kangentic_list_tasks](task-read-tools.md#kangentic_list_tasks)). That makes
this a complete read-before-write call for
[kangentic_reorder_tasks](task-tools.md#kangentic_reorder_tasks). The rendered message caps the listing at 50
tasks and says how many were omitted; `data.taskOrder` always carries the whole column.

The done-role column reports `Tasks: 0` and an empty `taskOrder`, because a task moved there is
archived off the board. It adds a `Completed: N` line with the size of the archive, and a
`Status: archived` line, which is its normal persisted state rather than a warning. In `data`,
`completedCount` carries that number and is `null` on every other column rather than absent.
This tool resolves any column by name, including one a user archived; the `Available:` list on a
miss names the board's columns plus the done column.

## kangentic_update_column

Update a swimlane (column) configuration. Use `kangentic_get_column_detail` to inspect current values first.

The role columns (To Do, Done) are editable here like any other: rename, describe, recolor, change the icon. Their `role` itself is structural and is not a settable field, and this tool never changes a column's archived state, so editing Done cannot dislodge it from the board.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name to update (case-insensitive) |
| `name` | string | No | New column name (max 100 chars) |
| `description` | string \| null | No | Free-form column purpose shown as a header tooltip and shared via `kangentic.json` (max 1000 chars). `null` clears. |
| `color` | string | No | Hex color (e.g. `"#71717a"`) |
| `icon` | string \| null | No | Lucide icon name, or `null` to clear |
| `autoSpawn` | boolean | No | Whether moving a task into this column auto-spawns an agent. For the ACTIVE project, changing it also applies to the tasks already in the column, immediately: switching it on spawns for each task with no session (never for a user-paused one, and never in To Do or Done), switching it off suspends the live sessions there |
| `autoCommand` | string \| null | No | The message this column sends its agent on entry (e.g. `"/review --strict"`). Supports template variables. Writes the column's first `send_message` automation in its On enter group, creating one if it has none; `null` deletes it. See [Column automations](automation-tools.md#column-automations). |
| `autoCommandMode` | string | No | `immediate` (type it as soon as the agent is ready) or `deferred` (wait for the agent to finish its current turn). Defaults to the row's existing mode, then `immediate`. |
| `agentOverride` | string \| null | No | Force a specific agent for this column. `null` uses project default. |
| `modelOverride` | string \| null | No | Adapter-specific model identifier passed at spawn time (e.g. Claude `"opus"`, `"sonnet"`, `"claude-opus-4-7"`). Stored as given; a friendly Claude name (`"Opus"`, `"Opus 5.5"`) is converted to Claude's spelling only when the Claude adapter builds `--model`, and a single word only when Claude's `/model` picker listed it as a family. `null` inherits the agent default. For the ACTIVE project this reaches sessions already running in the column: a model change restarts them in place with `--resume`. |
| `effortOverride` | string \| null | No | Adapter-specific effort/reasoning level (e.g. Claude `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`). Valid values are agent-specific. `null` inherits the agent default. For the ACTIVE project this reaches sessions already running in the column: an effort change restarts them in place with `--resume` and the new `--effort`. |
| `permissionMode` | string \| null | No | One of: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto`. `null` uses project default. |
| `handoffContext` | boolean | No | Enable multi-agent handoff context preservation when entering this column |
| `sessionTarget` | string | No | `main` or `isolated`. Which session a task runs on here: `main` continues the task's own conversation, `isolated` gives the column its own, keyed to the column. Not nullable, since the underlying column is NOT NULL: pass `"main"` to go back to the default. |
| `sessionSpawnStrategy` | string | No | `create_or_resume` or `always_spawn_new`. What the column does with that session on entry. Not nullable; pass `"create_or_resume"` to go back to the default. |
| `planExitTargetColumn` | string \| null | No | Column to auto-move the task to when an agent in plan mode exits planning. `null` disables. |
| `planApproval` | string | No | `automatic` or `manual`. Who approves a plan when the agent in this column finishes planning; only matters while `permissionMode` is `plan`. `manual` waits for the user in the agent's terminal; `automatic` has Kangentic approve it, so the task moves on to `planExitTargetColumn` by itself. A question the agent asks the user still waits. A workflow task can override it for itself (`planApproval` on the task), and a task with its automations disabled always waits for the user. Not nullable; pass `"manual"` to go back to the default. |

At least one updatable field is required.

**`planApproval: "automatic"` is stored for any agent.** The tool does not refuse it for an agent
that cannot have its plans approved, but that agent's plans still wait for the user.

**Changing `sessionTarget` carries `sessionSpawnStrategy` with it** unless you pass one explicitly.
Switching to `isolated` also switches the column to `always_spawn_new`, and switching back to `main`
returns it to `create_or_resume`, so an isolated column runs an independent pass per entry by
default. A strategy you set deliberately is never overwritten: the carry only fires when the
strategy still sits at the outgoing track's default, and restating a `sessionTarget` the column
already has changes nothing. To get a persistent isolated track (one long side conversation that
resumes), pass `sessionTarget: "isolated"` and `sessionSpawnStrategy: "create_or_resume"` together.

This mirrors the Column Manager's Session and On enter fields exactly; the rule is shared code
(`src/shared/session-track.ts`), not two implementations.

**Cross-project edits write the setting but do not reconcile.** When you target another board with
`project`, the column is updated and persisted to that project's `kangentic.json`, but no session
there is spawned, suspended, restarted, or injected. That is a blast-radius decision, not an
assumption that the project is idle: a background project CAN have live sessions (the Agent Monitor
and the sidebar's per-project agent counts exist for exactly that). Spawning creates a worktree and
checks out a branch in a checkout the user is not looking at, so the reconcile is held back and the
project's tasks pick the new settings up when they next spawn. The cost is that turning `autoSpawn`
off on a non-focused project leaves its agents running until it is next opened.

## kangentic_create_column

Add a new swimlane (column) to the board. Column names must be unique (case-insensitive) across
every lane, including the archived Done lane.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Column name, unique on this board (max 100 chars) |
| `description` | string | No | Free-form column purpose shown as a header tooltip and shared via `kangentic.json` (max 1000 chars) |
| `color` | string | No | Hex color (e.g. `"#71717a"`). Defaults to blue. |
| `icon` | string | No | Lucide icon name |
| `autoSpawn` | boolean | No | Whether moving a task into this column auto-spawns an agent. Defaults to `true`. |
| `autoCommand` | string | No | The message this column sends its agent on entry (e.g. `"/review --strict"`). Creates the column's first `send_message` automation in its On enter group. See [Column automations](automation-tools.md#column-automations). |
| `autoCommandMode` | string | No | `immediate` (default) or `deferred` (wait for the agent to finish its current turn). |
| `agentOverride` | string | No | Force a specific agent for this column. Omit to use the project default. |
| `modelOverride` | string | No | Adapter-specific model identifier passed at spawn time (e.g. Claude `"opus"`, `"sonnet"`). Stored as given; the Claude adapter converts a friendly Claude name (`"Opus 5.5"`, or `"Opus"` once its picker has listed that family) at spawn. |
| `effortOverride` | string | No | Adapter-specific effort/reasoning level (e.g. Claude `"low"`, `"high"`, `"xhigh"`) |
| `permissionMode` | string | No | One of: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto` |
| `handoffContext` | boolean | No | Enable multi-agent handoff context preservation when entering this column |
| `sessionTarget` | string | No | `main` (default) or `isolated`. `isolated` gives the column its own conversation instead of continuing the task's. |
| `sessionSpawnStrategy` | string | No | `create_or_resume` or `always_spawn_new`. Defaults to `always_spawn_new` when `sessionTarget` is `isolated`, `create_or_resume` otherwise. |
| `planExitTargetColumn` | string | No | Column to auto-move the task to when an agent in plan mode exits planning |
| `planApproval` | string | No | `automatic` or `manual` (default). Who approves a plan when the agent in this column finishes planning; only matters while `permissionMode` is `plan`. See [kangentic_update_column](#kangentic_update_column). |
| `position` | number | No | Zero-based ordinal slot among the board's columns (not a raw stored `position`); later columns shift right. Clamped between the role columns: a value below the lowest legal slot lands immediately after To Do (so `position: 0` does not come first), and a value at or past Done lands immediately before Done, never after it. Omit for the default placement just before Done. |

Roles are structural and cannot be set: every board already has its To Do and Done columns.

**A column that checks an earlier column's work wants `sessionTarget: "isolated"`.** On the default
`main` track the reviewer shares the task's conversation, which makes it the same agent that wrote
the code. Passing `sessionTarget: "isolated"` alone is enough; `sessionSpawnStrategy` follows it to
`always_spawn_new` under the rule described in
[kangentic_update_column](#kangentic_update_column). A working review column is one call:

```json
{
  "name": "Code Review",
  "autoCommand": "/code-review",
  "sessionTarget": "isolated",
  "icon": "code"
}
```

## kangentic_delete_column

Delete a swimlane (column) from the board. Refused in two cases, deliberately:

- **The column still holds tasks.** Move them with `kangentic_move_task` (or delete them) first.
  This tool never touches a task: bulk-moving or orphaning them is a far larger action than the
  caller asked for.
- **The column is a role column** (To Do / Done). The board depends on both. Rename one instead if
  you only want different wording.

Everything that pointed at the column is cleaned up in the same operation: lane transitions,
other columns' `planExitTargetColumn` values, Board Profile entries keyed to it, and any profile
`planExitTarget` naming it. The response reports the counts. The committed `kangentic.json` mirror
is rewritten too, which is load-bearing rather than cosmetic - see
[Board Config Sync](../../settings/board-config.md#board-config-sync-kangenticjson): the file re-seeds the
database on project open, so a delete that left the file alone would be undone on the next open.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name to delete (case-insensitive) |

This cannot be undone.
