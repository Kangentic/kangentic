---
type: Reference
title: Task read tools
description: "Read-only MCP tools for tasks and board totals: list_tasks ordinal positions, find_task by display ID, branch or PR number with Knowledge Graph lines, get_task_report's route, commits and per-file changes, get_current_task from a worktree, board_summary label vocabulary, and get_task_stats and get_usage_stats cost, token and subagent fan-out figures."
tags: [mcp, tasks, stats, usage]
sources:
  - resource: src/main/agent/mcp-http/task-tools.ts
    title: Task read tool registrations
  - resource: src/main/agent/mcp-http/usage-tools.ts
  - resource: src/main/agent/commands/inventory-commands.ts
  - resource: src/main/agent/commands/search-commands.ts
  - resource: src/main/agent/commands/task-report-commands.ts
  - resource: src/main/agent/commands/analytics-commands.ts
  - resource: src/main/agent/commands/usage-commands.ts
  - resource: src/main/agent/commands/task-knowledge-lines.ts
---
# Task read tools

## kangentic_list_tasks

List tasks, optionally filtered by column. Tasks come back in board order (top to bottom within each column).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | No | Filter by column name. If omitted, returns all tasks. |

This lists tasks on the board. Filtering by the done column resolves and returns nothing, since a
task moved there is archived off the board; reach completed tasks with
[kangentic_search_tasks](search-tools.md#kangentic_search_tasks) at `status: "completed"`.

Each task reports a `position`: its zero-based ordinal slot within its own column, counting only
non-archived tasks. This is the same slot vocabulary
[kangentic_move_task](task-tools.md#kangentic_move_task)'s `position` and
[kangentic_reorder_tasks](task-tools.md#kangentic_reorder_tasks) accept, so the listing can be read and handed
straight back. It is deliberately not the raw stored `tasks.position` value, which develops gaps
as tasks are archived.

Each task also reports its labels, rendered as `[a, b]` after the title - the same shape the
backlog rows in [kangentic_search_tasks](search-tools.md#kangentic_search_tasks) already use, so board and backlog
rows read identically. Omitted entirely for a task with no labels. For the board's label vocabulary
as a whole (with counts) use [kangentic_board_summary](#kangentic_board_summary); a listing is
filtered and count-free and cannot answer that.

## kangentic_find_task

Find a task or backlog item by display ID, UUID, branch name, title keyword, or PR number. Returns matching board tasks (with full `branch_name`, `worktree_path`, PR info) and any matching backlog items.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `displayId` | number | No | Numeric task display ID shown in UI (e.g. `24` for "#24"). Board-only, exact match. |
| `id` | string | No | Full UUID. Matches both board task UUIDs and backlog item UUIDs. |
| `branch` | string | No | Git branch name (matches the `tasks.branch_name` column, partial). Board-only. |
| `title` | string | No | Title keyword (case-insensitive). Matches board tasks and backlog items. |
| `prNumber` | number | No | Pull request number. Board-only. |

`displayId`, `branch`, and `prNumber` are skipped against the backlog because backlog items don't carry those fields. At least one parameter is required.

Under each matched board task's line the message prints its description, indented (`taskDescriptionLines`). The agent reads the message, not `data`, so a task looked up for what it asks needs it there. A lone match shows up to 4,000 characters, and each of several matches up to 400, with a last line saying how many more characters were left out. A task with no description prints nothing.

Under each of the first five matched board tasks the message carries what the Knowledge Graph knows about it, read from the index (`src/main/retrieval/task-knowledge.ts`, formatted by `src/main/agent/commands/task-knowledge-lines.ts`):

- **Summary.** For a finished task (archived or in a Done column), the sentence or two an agent wrote when it finished, with the date: `summary (2026-09-20): ...`. A finished task without one reads `summary: not written yet`, or says Task summaries are switched off. A written summary shows whatever that switch says: the switch stops new ones, and the written ones keep helping, as they do in search and Ask.
- **Commits.** The default-branch commits linked to the task, newest first, at most three with the total: `commits linked by subject (5, newest first): <sha> <date> <subject>; ...; and 2 more`. The link is where the subject was first written, not a merge record (measured 1,254 of 1,272 right). A squash-merge's `(#812)` is spelled `(PR 812)`, since `#N` names a task. A finished task with none reads `commits: none linked to this task`.
- **Changed files.** The files its sessions changed, most-changed first, at most eight with the total: the same files a summary is written from.

Past five matches one line says to look a task up by `displayId` for its details. With the index off (`knowledgeGraph.indexingEnabled`) one line says so and nothing is read. `data.tasks[].knowledge` carries the same fields.

A task whose column automations are paused says `automations paused` in its task line, and `data.tasks[].automationsDisabled` is `true`; the line says nothing about automations otherwise.

## kangentic_get_task_report

Read what a task's completed view shows that `kangentic_find_task` does not, as JSON in the protocol's `TaskReportWire` shape (`packages/protocol/src/capabilities/task-report.ts`). The phone reads the same result through `board-tool-read` with `tool: "get_task_report"`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Numeric display ID (e.g. `"42"`) or full UUID. |
| `project` | string | No | Project name or UUID, to read a task in a different project. |

The handler (`src/main/agent/commands/task-report-commands.ts`) calls the view's own two reads, `readTaskReport` and `readTaskChanges`, through `CommandContext` callbacks, and runs them together:

- **Route.** Each working column the task stayed in, in board order, with its total time and its stays (`visits`, oldest first, at most 50 per column, with `visitCount`).
- **Span.** `startedAt` is the earlier of the first move into a working column and the first session start; `endedAt` is the last move into Done, else the last session end.
- **Commits.** The commits the index links to the task, newest first, at most 100, with `commitCount`. Both are null when the index is off or could not be read.
- **Changes.** Each changed file from git, biggest change first, with status, lines added and removed, and `binary`, at most 200 with `fileCount`. `totals` is set only when one span of history holds the whole change, which is when the view's header strip prefers it. A git failure costs this section only. `changes` is then null and `changesError` says why.
- **Summary state.** Whether a summary is written (with its text), pending, switched off, or not readable because indexing is off.

The turn ledger the Usage tab reads is left out. An unknown task returns an error naming the id.

## kangentic_get_current_task

Resolve the task that corresponds to the current working directory and/or git branch. Use at the start of work in a worktree to confirm which task you are operating on (e.g. before commits, PRs, or merge-back).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | No | Absolute working directory path. The tool extracts the worktree folder name from `.kangentic/worktrees/<folder>` and matches against `tasks.worktree_path`. |
| `branch` | string | No | Current git branch name. Exact (case-insensitive) match against `tasks.branch_name`. |

At least one parameter is required. The message is what the agent reads, so a single match prints `Current task:` and the same task line, description and Knowledge Graph lines `kangentic_find_task` prints (branch, base, worktree, PR, description, summary, commits, changed files), and an ambiguous match lists every candidate. The description has the same cut: 4,000 characters for one match, 400 each among several. `data` carries the same task fields as `kangentic_find_task` (id, displayId, title, description, column, branchName, baseBranch, worktreePath, prNumber, prUrl, useWorktree, automationsDisabled, status). It deliberately does NOT report reserved ports: this serializer is a per-project read and the ledger is in the GLOBAL database, so including them made every task lookup depend on a second database and cost one query per matched task. Use `kangentic_check_dev_ports`, which answers that question and probes each port besides. Returns `data: null` when no match is found, a single task object when one matches, or an array when multiple tasks match.

## kangentic_board_summary

Get a high-level board overview: task counts per column, the board's label vocabulary, active sessions, completed tasks, and aggregate cost/token metrics.

No parameters.

The column list covers the whole ladder, done column included. That column reports its completed
count rather than a live task count, for the reason given under
[kangentic_list_columns](column-tools.md#kangentic_list_columns).

**Label vocabulary.** The summary lists the labels already in use with their counts, most-used
first, so a caller can reuse an existing label instead of inventing a near-duplicate and
fragmenting the vocabulary. This is the answer to "what labels does this board use" - a task
listing cannot serve it, being paginated and count-free.

Counts span every item that can carry a label: active board tasks, archived (Done) tasks, and
backlog items. Archived tasks are included deliberately - on a mature board most of the vocabulary
lives in Done, so an active-only tally would report a vocabulary that barely exists. The two
figures in the header measure different things and are both needed: `N distinct` is the size of the
vocabulary, while `M labelled items` counts items carrying at least one label. The per-label counts
are label *uses*, so a task with three labels contributes to three of them and they sum to more
than `M`.

The list is capped at 30 entries with a `... and N more` tail. Label colors are deliberately not
reported: passing an existing label back as a plain string preserves the color it already has, so a
caller never needs one.

`data.labels` carries the same tally as `{ name, count }` entries in the same most-used-first order,
and is **not** capped the way the printed list is, so a caller that needs the whole vocabulary can
read it there.

## kangentic_get_usage_stats

Aggregated agent-usage statistics for one project or rolled up across every registered
project: the four token types, cost, burn rate ($/hr + tokens/hr), sessions, tool
calls, line churn, compactions, active time, and by-model / by-agent / by-effort / by-subagent-type
breakdowns (a null effort means the agent default; a session that switches effort
mid-run attributes all its usage to the last-applied value). This is the same data the
in-app usage dashboard shows, over the same time ranges.

`bySubagentType` and the `subagent*` KPI fields cover Task-tool subagents: the finders a
`/code-review` fans out, the agents a `/test` spawns. They answer which subagent costs
the most, rather than only what a review cost in total. They are ADDITIVE to the turn
token fields and to both time series, which are the main thread by construction and stay
that way so the historical series remains comparable. Subagent rows carry no cost of
their own, because `totalCostUsd` already covers the whole session tree; summing prices
for them would double count. `byAgent` is a different axis: that is the CLI that ran the
session (Claude vs Codex), not a subagent inside one. For ONE task's fan-out, use
`kangentic_get_task_stats` with a `taskId`.

`subagentNestedCount` names how many of those subagents were spawned by another subagent
rather than by the driver. It is a subset of `subagentCount`, never an addend: their
tokens are already inside the four `subagent*` totals.

A `Not counted:` line names agents in the range that CANNOT report subagent usage, from
`subagentBlindAgents`. Only the Claude adapter implements subagent capture today, so a
Codex or Gemini range reports an empty breakdown that otherwise reads as a measurement
("nothing fanned out") when it is really a blind spot. The list is derived from which
adapters declare the capability, not from agent names in the reporting layer.

Reads the durable usage ledgers (`usage_history` per-session cost and
`conversation_turn_usage` per-turn tokens, plus `background_calls` for the Background line below), so totals survive task and session deletion.
Usage from in-flight sessions is excluded until they finalize.

Every read runs in the retrieval worker. While that worker cannot answer (restarting after a crash,
or shut down at quit), the tool returns an error, `Usage stats were not read. The Knowledge Graph
index is restarting. Try again in a moment.`, rather than totals that leave out the projects it
never reached. A project whose own database cannot be read is handled apart. It is skipped, its
reads stay out of every total, and an all-projects call's message counts it as
`(N skipped, unreadable DB)`. A single-project call has no skip count.

Tokens are reported as four DISJOINT types - fresh input, output, cache write, cache
read - which is the split `claude_code.token.usage` reports and the one ccusage columns.
There is no combined total: cache read is an order of magnitude larger than fresh
traffic and priced completely differently, so one number would be dominated by the
cheapest component. Token coverage starts at `earliestTurnMs`, which is LATER than the
cost ledger's start on any install that predates per-turn capture, and the CLI prunes
the transcripts that would backfill it. `usage_history`'s own token columns are not used
for these figures: they are `context_window` totals, which Claude Code 2.1.132+ reports
as current context occupancy rather than consumption.

Cost is API-equivalent list price, not what a subscription was billed, and is stored as
per-leg deltas so a resumed conversation is not counted once per `--resume`. Both burn
rate lines divide the same elapsed hours into the number the corresponding field
reports, so `$/hr x range hours` reproduces `totalCostUsd`. Subscription sessions
reporting $0 count tokens but no cost.

`activeMs` and `activeSessionsCovered` are agent-working time from the activity-interval
ledger, matching `claude_code.active_time.total`. The pair travels together because the
interval ledger covers fewer sessions than `sessionCount` does: dividing by the larger
count would mix two ledgers.

A `Background (not in the totals above)` line reports the headless calls Kangentic made on the
user's behalf in the range (Condition checks, workflow step checks, task summaries, task titles,
terminal names), from `background_calls`: the call count, cost, the four token types, and the
calls per job. `data.background` carries the totals and the per-job figures; its per-day rows are a
series, kept only with `includeSeries`. None of it is added to any session figure.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `period` | string | No | Time range: "live" (trailing 2 hours), "today", "week", "month", or "all" (default). "today"/"week"/"month" start at the machine's local midnight / Monday / 1st of month. |
| `allProjects` | boolean | No | Roll up across every registered project, with per-project sub-totals. Takes precedence over `project`. |
| `includeSeries` | boolean | No | Include the bucketed token/cost time series, and the Background per-day rows, in the response (larger). Default: false (KPIs + breakdowns only). |
| `project` | string | No | Project name or UUID to target a different project than the active one. |

## kangentic_get_task_stats

Get session metrics for a specific task or across all tasks. Across all tasks, each row starts with the task's `#N`, so the agent can follow one up.

Cost and agent runtime are the completed task view's: each conversation's running total read once, then added across conversations, so a resumed task is not counted once per `--resume` (see the `sessions` table in [Session tables](../../database/session-tables.md#sessions-table)). With a `taskId`, the runtime line reads `Agent runtime`.

With a `taskId`, the response also carries `bySubagentType`: the task's Task-tool
subagent fan-out from `conversation_turn_usage`, one row per subagent type with its
token counts, turn count and distinct-subagent count. On a `/code-review` or `/test`
task that is usually most of the traffic, and it is the only place the board can say
which subagent was expensive. It reports no cost of its own: the task's reported cost
already covers the whole session tree. The rows are absent for a task with no fan-out,
and for one whose subagent transcripts the agent pruned before they were indexed. A type
that ran anything nested also names how much: `N nested` on the summary line and
`(N nested)` on its own row, omitted entirely at zero rather than printed as `0 nested`.

The message then carries a `Fan-outs:` section, and `data.fanOuts`, grouping the same
turns by the DRIVER TURN that started each one - the question the per-type rollup cannot
answer, since a `/code-review` task spawns the same `review-finder` from several turns.
Each line reads `14:32 - review-finder x6, 1.2M fresh tokens, 28.4M cache read`, heaviest
first, capped at five with a `+N more` tail. A nested subagent is folded into the fan-out
that ultimately caused it, by walking its parent chain up to the driver. Subagents whose
parent cannot be resolved print as one `(unlinked)` row instead of being dropped: spawn
links only exist for sessions indexed since they shipped, so on an older task that is
every row, and omitting them would leave the fan-out lines disagreeing with the per-type
totals directly above.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Specific task ID. If omitted, returns aggregate stats (no subagent breakdown). |
| `query` | string | No | Filter tasks by keyword before aggregating |
| `sortBy` | string | No | Sort metric: "tokens", "cost", "duration", "toolCalls", "linesChanged" |
| `project` | string | No | Project name or UUID to target a different project than the active one. |
