---
type: Reference
title: Column automation tools
description: "Column automations over MCP: the five automation types and their fields, the condition, finalLine and maxRuns guards, which rows can never run and why, and the list_automations, set_automations, get_automation_runs and run_automation tools."
tags: [mcp, automations, columns]
sources:
  - resource: src/main/agent/mcp-http/automation-tools.ts
  - resource: src/main/agent/commands/automation-commands.ts
  - resource: src/shared/automation-manifest.ts
    title: AUTOMATION_MANIFEST
---
# Column automation tools

## Column automations

What a column does when a task enters it, each time its agent finishes a turn there, and when it
leaves. Each column owns one ordered list, split into three groups (`on`: `enter`, `turn_end`,
`exit`), and each row has its own switch. Five types ship:

| Type | What it does | Fields |
|------|--------------|--------|
| `send_message` | Types a message at the column's agent | `message`, `mode` (`immediate` / `deferred`) |
| `run_script` | Runs a script in the task's worktree, or the project checkout when it has none | `script`, `timeoutMinutes` (1 to 120, default 10, file only) |
| `webhook` | Calls a URL, retrying a transport error, 408, 429 or 5xx, for up to 3 attempts in total | `url`, `method`, `body`, `headers` |
| `notify` | Notifies the user on the desktop and every paired phone | `title`, `body` |
| `move_to_column` | `turn_end` only. Moves the task, and hands the agent there a message; ends the group | `targetColumn` (omit for the next column), `message` |

Every row also takes guards, a Condition of one kind or the other and a Frequency:

- **`condition`**: a sentence in plain words, answered yes or no by the Automation agent (Settings >
  Workflows) before the row runs. A no is not a run, so the next trigger checks it again. Omit or
  `null` to always run. A row with a `condition` is skipped until an Automation agent is set up.
- **`finalLine`**: a Text match, the other kind of Condition, checked in code with no agent call. The
  row runs only when the last line of the agent's final message matches it, ignoring case,
  punctuation (markdown marks included) and extra spaces, with `*` as a wildcard (`"Verdict: Ready"`,
  `"PR: *"`). The pattern must cover the whole line. `turn_end` rows only, and a row gives this or
  `condition`, not both. A miss is not a run, like a no.
- **`maxRuns`**: Frequency, the most times the row may run on one task across every visit (a review
  loop's round-trip limit). The count starts over when a person moves the task to another column (a
  drag on the board, a move from the phone) and when the task leaves Done. A move an agent makes
  keeps the count, `kangentic_move_task` included, so an agent cannot reset its own limit. That
  holds when a person asked the agent to make the move. Moves by an automation or a workflow keep
  it too. Omit or `null` for no limit.

A `turn_end` row runs when the column's agent finishes a turn on its own (not an interrupt or a
failed turn), at most once per visit, top to bottom. `{{agentReply}}` resolves to that agent's final
message of the turn, whole, which is how a review's findings reach the next column.

Two names are accepted but not offered:

- **`send_command`** is an alias for `send_message`, and its `command` field an alias for
  `message`. That was the type's id before its field was renamed, and an older skill still spells
  it that way, so a write naming it is stored as `send_message`.
- **`spawn_agent`** (field `promptTemplate`) is the one legacy type. It cannot be created, it is
  not in the table above, and it exists only so a row that predates the automations model still
  runs. Starting an agent is the column's own "Start an agent here" setting, not an automation.

Every text field takes the template variables listed in
[transition-engine.md](../../architecture/automations/transition-engine.md), substituted literally: an unknown name is sent as
written rather than dropped. A script also receives each one as a `KANGENTIC_*` environment
variable, which is the quoting-safe way to read one.

These rules decide whether a row actually runs, and they are reported by
`kangentic_list_automations` rather than left to be discovered:

- A row whose switch is off is skipped.
- A `send_message` row on a column whose `autoSpawn` is off can never run: no agent starts there.
- An On enter row on To Do or Done can never run: neither column runs automations on entry.
- A `turn_end` row can never run on To Do or Done, on a column whose `autoSpawn` is off, or where
  the column's agent can't report when it finishes a turn. The reasons read "Nothing runs at a turn
  end in To Do." (or "in Done."), "Start an agent here is off, so no agent ends a turn here.", and
  "This column's agent can't report when it finishes a turn."
- A type written under a trigger it does not run on (`move_to_column` on `enter` or `exit`) is
  refused by `kangentic_set_automations`, with the reason ("Move to column runs only at a turn
  end.").

Every execution writes a row to the run log, whatever happens, which is what
`kangentic_get_automation_runs` reads. A row left `running` was in flight when Kangentic quit; the
shutdown path is synchronous by rule, so it could not be drained, and nothing is retried
automatically (a fired webhook and a half-run script are not safe to repeat blind).

## kangentic_list_automations

Read a column's automations, or the whole board's. This is the right first call for "what does this
board do": a board-wide read answers it once instead of one call per column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | No | Column name (case-insensitive). Omit to read every column. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

Each row reports its `id`, `name`, `type`, `on`, `position`, `enabled`, `condition`, `finalLine`,
`maxRuns`, and the type's own fields. `condition`, `finalLine` and `maxRuns` are null when the row
has none. A row that cannot run as things stand is flagged with the reason.

The text lists each row on one line: its name, its type, and the sentence the Column Manager shows
(the verb and the one required value), then every option the panel shows as a mark, in words, in
parentheses. The action's own options come first, then the Condition and the Frequency:

```
Moves the task to Executing (with a message; only if the review is clean; at most 3 times until you move the task)
Moves the task to Testing (only if the last line reads "Verdict: Ready")
```

A waiting Send message reads "waits for the current turn to end", on enter and exit only: at a turn
end the turn is already over, so it sends at once. A Move to column row's message text is in the
row's data, not the line.

## kangentic_set_automations

Replace one column's automations wholesale. The array becomes that column's entire list, in order,
so read the current rows with `kangentic_list_automations` first and send them back with your
change applied. Pass `[]` to remove them all.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column whose automations to replace (case-insensitive) |
| `automations` | array | Yes | The column's complete new list, in run order. Max 50. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

Each entry takes `name` (required, unique within the column ignoring case), `type`, an optional
`on` (`enter` by default, or `turn_end` or `exit`), an optional `enabled` (true by default), an
optional `condition` or `finalLine` and an optional `maxRuns` (all off by default), an optional
`id`, and the type's own fields flat on the object. The `on` key belongs to this tool's input
only: `kangentic.json` stores the same rows in one array per trigger and has no `on` key (see
[Configuration cascade](../../settings/cascade.md#column-automations)).

```json
{
  "column": "Code Review",
  "automations": [
    { "id": "623a36ef-...", "name": "Review", "type": "send_message", "message": "/code-review {{baseBranch}}" },
    {
      "name": "Back for revisions",
      "type": "move_to_column",
      "on": "turn_end",
      "targetColumn": "Executing",
      "message": "Back from {{column}}. What the review found:\n{{agentReply}}",
      "finalLine": "Verdict: Blocked",
      "maxRuns": 3
    },
    { "name": "Clean", "type": "move_to_column", "on": "turn_end", "condition": "The review is clean" },
    { "name": "Archive the log", "type": "run_script", "on": "exit", "enabled": false, "script": "scripts/archive.sh" }
  ]
}
```

Whole-column rather than per-row because a reorder, a delete and an insert arrive together, and
applying them separately would make the unique name index reject an intermediate state the final
state does not have. Carry each existing row's `id` through so it keeps its identity and its run
history; a row with no `id` is created fresh. Array order is each row's position within its trigger
group, so the three groups number independently.

A row the column cannot run as things stand is stored and warned about, not refused: building a
list before switching the column's agent on is a legitimate order of operations. Two things ARE
refused, with the reason, so nothing is stored that could never be what the caller meant: an
unknown `on`, and a type written under a trigger it does not run on (`move_to_column` runs on
`turn_end` only). A `maxRuns` that is not a whole number of at least 1, or a `condition` or
`finalLine` that is not a string, is refused too. So is a `finalLine` on an `enter` or `exit` row
("finalLine works only with on: "turn_end"..."), a `finalLine` with no letter, number or `*`,
which no last line can match, and a row that gives both a `condition` and a `finalLine` ("give a
condition or a finalLine, not both"). A blank `finalLine` reads as none. Every refusal ends
"Nothing was saved."

## kangentic_get_automation_runs

Read the run log. Ask by task (everything that ran for one card) or by column (every run of the
automations that column holds now). Newest first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | No | Task ID (numeric display ID or UUID). One of `task` or `column` is required. |
| `column` | string | No | Column name (case-insensitive). One of `task` or `column` is required. |
| `limit` | number | No | Maximum runs to return, 1 to 50. Defaults to 50. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

Each run carries its status (`running`, `succeeded`, `failed`, `skipped`, `interrupted`), the
`detail` (the failure reason, the skip reason, or a one-line success such as `HTTP 204` or
`exit 0`), the attempt count, and its timestamps. A run whose row has a Condition also shows whether
the Automation agent found it met or not met, and the agent's one-line reason. A run whose row has a
Text match shows `[text match met: ...]` or `[text match not met: ...]` with the line it read
(`The final line reads "Verdict: Blocked".`), and no check line, since no agent was asked. The log denormalizes the automation's name and
type and takes no foreign key to the automation, so renaming or deleting one does not empty its
history.

A run a check answered (or a check that ran without answering, such as a timeout) gets one more line
naming that call, from `background_calls`: the agent and model (what the CLI reported, else what was
asked for), the effort, the four token counts and cost as the CLI reported them, how long it took,
and how many rows the one call answered. In `data`, the same facts are `run.check`.

```
  checked by Claude Code (claude-haiku-5-5, low): 2,104 fresh input + 45 output, 120 cache write, 1,012 cache read, $0.0026, 1.9s, one call for 2 rows
  checked by Codex CLI (default model): usage not reported, 4.6s
```

## kangentic_run_automation

Run one automation now, against the named task's current state. Use it to retry a failed automation
or to test one you just wrote.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column the automation belongs to (case-insensitive) |
| `automation` | string | Yes | Automation name on that column (case-insensitive) |
| `task` | string | Yes | Task ID (numeric display ID or UUID) to run it against |
| `project` | string | No | Project name or UUID. Omit for the active project. |

Current state, not the state of the move that first ran it. A task can have moved twice since a
failure, so `{{toColumn}}` resolves against where it is now, while `{{fromColumn}}` and
`{{trigger}}` resolve empty because there is no move. It writes a fresh run row either way. A
`turn_end` row whose Text match, Condition or `{{agentReply}}` reads the final message is judged
against the newest one the task's session wrote, read before the run. A row that reads no message
skips the read, and a message from a session a move has since replaced counts as none.

It will not start an agent: a `send_message` automation against a task with no live session is
recorded skipped rather than spawning one. It takes the task lock and is capped at five minutes, so
a hung row cannot wedge that task's next move.

A `move_to_column` automation moves the task the way a turn end would, so an agent can recover a
turn end whose rows never ran. It moves the task only from that automation's own column, and is
refused once the task has left it. It runs outside the task lock, since the move takes that lock
itself.
