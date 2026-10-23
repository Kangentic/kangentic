---
type: Reference
title: Board profile tools
description: "Board Profiles over MCP: named per-column agent, model and effort presets stored in kangentic.json and keyed by column name, the omit, null and value three-state rule, merge versus replaceColumns, and the live-session effects of editing or deleting a profile."
tags: [mcp, profiles, board]
sources:
  - resource: src/main/agent/mcp-http/profile-tools.ts
  - resource: src/main/agent/commands/profile-commands.ts
---
# Board profile tools

## Board Profiles

A **Board Profile** is a named alternate ladder of per-column strategy settings, so one task can
run Planning in Opus xhigh and Merge in Sonnet high while another rides a cheaper ladder over the
same board. Column *identity* (which columns exist, their name, order, role, color, icon) is
singular across profiles; only strategy is profile-scoped. Profiles live in `kangentic.json`, not
the database, so they are team-shared and travel through git. A task selects one with `profile` on
[kangentic_create_task](task-tools.md#kangentic_create_task) / [kangentic_update_task](task-tools.md#kangentic_update_task).

There is no stored "Default" profile. Default is synthetic: a task with no profile simply runs each
column's own settings, which is why it never appears in a listing.

**Entries are keyed by column NAME across this whole tool family.** Internally a profile keys its
entries by swimlane uuid so a rename cannot detach in-flight tasks, but a uuid is useless to an
agent and actively wrong across projects - the entire point of copying a profile into project X is
that X has its own columns with their own ids. Every tool below translates names to ids on write
and back to names on read, and an unknown column name fails the call rather than being silently
dropped.

**Three states per setting**, and the difference is load-bearing:

| Form | Meaning |
|------|---------|
| key omitted | Inherit whatever the column itself is configured with |
| key set to `null` | Clear to the agent default, overriding the column's own pin |
| key set to a value | Use that value in this column |

Because these tools all accept `project`, they are the practical way to keep profiles in sync as
models and strategies change: *"change every profile's Opus 4.8 to Opus 5"*, *"copy this board's
Heavy profile into project X"*, *"what differs between project A's and B's profiles"* (two
`kangentic_list_board_profiles` calls and a diff).

The per-column settings a profile may carry are `agentOverride`, `modelOverride`, `effortOverride`,
`permissionMode`, `autoSpawn`, `handoffContext`, `sessionTarget`, `sessionSpawnStrategy`, and
`planExitTarget` (a column *name*). To Do and Done columns never spawn agents, so entries for them
have no effect.

A column's message to its agent is NOT one of them. It is a `send_message` automation now, and
automations are shared by every profile, which is what the Column Manager's pane says and why that
pane is read-only under a profile. The retired `autoCommand` and `autoCommandMode` keys are refused
with a pointer to [kangentic_set_automations](automation-tools.md#kangentic_set_automations) rather than accepted and
ignored.

## kangentic_list_board_profiles

List the board's Board Profiles: id, name, description, and per-column settings keyed by column
name (only the columns each profile overrides). Returns JSON, because the primary uses are diffing
and copying, both of which need the exact structure back out - and because a `null` (clear) must
stay visibly distinct from an absent key.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Read another project's profiles. Call twice to compare two boards. |

Entries for columns that no longer exist are omitted, so the listing reflects what will actually
apply.

## kangentic_create_board_profile

Create a Board Profile. Names must be unique on the board.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Profile name, unique on this board (e.g. `"Heavy"`, `"Frugal"`), max 100 chars |
| `description` | string | No | What this profile is for (max 500 chars) |
| `columns` | object | No | Per-column settings keyed by column name, e.g. `{"Planning": {"modelOverride": "opus", "effortOverride": "xhigh"}}`. Sparse: list only the columns this profile changes. |
| `project` | string | No | Create it on another project's board |

## kangentic_update_board_profile

Rename a profile, change its description, or retune its per-column settings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `profile` | string | Yes | Profile name (case-insensitive) or id |
| `name` | string | No | New name. Must stay unique on the board. |
| `description` | string | No | New description. Pass an empty string to clear it. |
| `columns` | object | No | Per-column settings keyed by column name |
| `replaceColumns` | boolean | No | Replace the profile's entire column set instead of merging into it. Default `false`. |
| `project` | string | No | Update a profile on another project's board |

`columns` **merges** by default, so retuning one column does not wipe the rest - which is what makes
a sweep like *"change every profile's Opus 4.8 to Opus 5"* safe to run column by column. Pass
`replaceColumns: true` for a wholesale swap, the usual choice when copying a profile from another
board.

On the ACTIVE project this reaches live sessions, exactly as the Board Manager's own profile save
does: retuning `modelOverride` / `effortOverride` restarts the sessions of tasks riding the
profile with the new flags, and retuning `autoSpawn` for a column spawns or suspends the tasks already
sitting in it. A profile edit targeting a background project (via `project`) only writes the file;
see the blast-radius note under [`kangentic_update_column`](column-tools.md#kangentic_update_column).

## kangentic_delete_board_profile

Delete a Board Profile.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `profile` | string | Yes | Profile name (case-insensitive) or id |
| `project` | string | No | Delete from another project's board |

Tasks riding the deleted profile are **not** rewritten; they fall back to each column's own settings,
and the response reports how many were affected. Rewriting those rows would make a delete far more
destructive than it looks and could not be undone by re-creating the profile.

Falling back to the column's own settings IS a settings change for a running session, so on the
active project it propagates like any other profile edit. Usually that just re-tunes the model or
effort and the session keeps running. The one case where it does not: if the deleted profile was
what turned `autoSpawn` **on** for a column whose own setting is off, the fallback is a true-to-false
flip, and the live session there is suspended (resumable by hand) rather than left running.
