---
type: Reference
title: Task tools
description: "Parameters and guards for creating, updating, moving, reordering, deleting and PR-linking board tasks over MCP: kangentic_create_task's call-time override validation, branch conflict guard and 500-task cap, update_task description edits, and move_task slots and message hand-off."
tags: [mcp, tasks, create, move]
sources:
  - resource: src/main/agent/mcp-http/task-tools.ts
  - resource: src/main/agent/mcp-http/spawn-override-validation.ts
  - resource: src/main/agent/commands/task-commands.ts
  - resource: src/main/agent/commands/task-ordering.ts
  - resource: src/main/agent/commands/move-message-limit.ts
  - resource: src/main/pr/pr-readiness-note.ts
---
# Task tools

## kangentic_create_task

Create a task on the board (default: the To Do column on the active board) or in the backlog. This is the only task-creation tool. Pass `column: "Backlog"` (case-insensitive) to create a backlog item instead of a board task. With no `column`, the task always lands in the active board's To Do column - never the backlog.

The done-role column is refused. A task created there would be archived off the board the moment it existed, so the error says that and points at [kangentic_move_task](#kangentic_move_task), rather than reporting the column as missing. [kangentic_promote_backlog](backlog-tools.md#kangentic_promote_backlog) and [kangentic_move_task_to_project](project-tools.md#kangentic_move_task_to_project) refuse it the same way, for the same reason.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Task title (max 200 chars) |
| `description` | string | No | Task description, supports markdown (max 50000 chars for a board task; a backlog item is capped at 10000 and an over-cap backlog description is rejected) |
| `column` | string | No | Target column name (case-insensitive). Defaults to To Do. Pass `"Backlog"` to route to the backlog staging area instead of the board. |
| `priority` | number | No | Priority: 0=none (default), 1=low, 2=medium, 3=high, 4=urgent. Applies to both board tasks and backlog items. |
| `labels` | array | No | Labels for categorization. Each entry is a string or `{ name, color }` object with hex color. Applies to both board tasks and backlog items. Call [kangentic_board_summary](task-read-tools.md#kangentic_board_summary) first to see the board's existing label vocabulary. Subject to the large-description drop; see the Labels with a long description note below. |
| `branchName` | string | No | Custom git branch name. Board tasks only - ignored when routed to the backlog. Recorded on the task and checked out when its worktree is created. Rejected if the branch is already checked out anywhere; see the Branch conflict guard note below. |
| `baseBranch` | string | No | Base branch for the task. Board tasks only. |
| `useWorktree` | boolean | No | Whether to use a git worktree. Omit to get one whenever the project allows worktrees. `false` means nothing is checked out at all - see the Working in the project directory note below. Ignored while the project has worktrees turned off (Settings > Git). Board tasks only. |
| `attachments` | array | No | File attachments: `[{ filePath: string, filename?: string }]`. Files are read from disk and stored in the project's `.kangentic/` directory. |
| `agentOverride` | string | No | Pin a specific agent for this task's entire lifetime (e.g. `"claude"`, `"codex"`). Locks against column moves. Rejected if it is not a registered agent. Omit to resolve column override -> project default -> app default. |
| `modelOverride` | string | No | Model to spawn this task with (e.g. `"opus"`, `"claude-opus-4-8"`, or the friendly `"Opus 4.8"` / `"Opus"`). A friendly name that contains a space is converted to the CLI's spelling (`"Opus 4.8"` -> `claude-opus-4-8`, `"Sonnet (1M)"` -> `sonnet[1m]`) and then validated; a single word (`"Opus"`) is stored as written, and the Claude adapter turns it into the floating alias `opus` at spawn only when Claude's `/model` picker listed that family; see the Call-time override validation note below. Omit to resolve column override -> project default -> agent default. |
| `effortOverride` | string | No | Effort/reasoning level to spawn this task with (e.g. `"xhigh"`). Valid values are agent-specific and validated at call time; see the Call-time override validation note below. Omit to resolve column override -> project default -> agent default. |
| `permissionMode` | string | No | Permission mode to spawn this task with: `"default"`, `"plan"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`, or `"auto"`. Omit to resolve column override -> project default -> app default. |
| `autoCommand` | string | No | Message to send once the agent spawns for this task (e.g. `"/code-review"`, `"/release"`). Sent in place of the destination column's first Send message row for this task only. If no Send message row sends it, it goes out once after the enter group. Not sent when the task's main session starts over on a recap of a deleted conversation, or on a move out of Done. An isolated column's fresh pass after an expired conversation still sends it. MCP-only - not surfaced in the New Task dialog. |
| `profile` | string | No | Board Profile this task rides (name or id) - an alternate set of per-column agent/model/effort settings, applied as the task moves. Omit for "Default" (every column uses its own settings). See [kangentic_list_board_profiles](profile-tools.md#kangentic_list_board_profiles). |
| `runMode` | string | No | How the task gets its agent settings: `"column_settings"` (the default - follow each column as the task moves) or `"agent_override"` (pin agent/model/effort/permission for the task's whole life). Any of the four `*Override` params implies `"agent_override"`, so pass this only to choose override mode without pinning anything - fields left unset then resolve dynamically until the task first spawns or leaves To Do, whichever comes first, which locks all four. Passing a pin together with `"column_settings"` is rejected as a contradiction. |
| `prUrl` | string | No | Pull request URL this task is about (e.g. `https://github.com/owner/repo/pull/123`). Board tasks only. |
| `prNumber` | number | No | Pull request number this task is about. This is the field the linker actually anchors on (Tier 1); it is derived from `prUrl` when omitted, so passing the URL alone is enough for a standard `/pull/<n>` URL. Board tasks only. |
| `automationsDisabled` | boolean | No | Create the task with its column automations paused: no On task enter, On agent turn end or On task exit automation runs for it, in any column, and Kangentic approves none of its plans, until resumed with `kangentic_update_task`. See [Disabling automations for one task](../../architecture/automations/triggers.md#disabling-automations-for-one-task). The response says so and `data.automationsDisabled` reports it. Board tasks only. |

**Filing a review task:** `prUrl` / `prNumber` are how a task names the PR it is about, and they are what links it. Writing the URL into `description` instead does **not** link it - the linker's anchors are git state and the stored `pr_number` only, never authored prose (see [PR linking](../pull-requests/pr-linking.md#the-confidence-ladder)). Both are applied as a follow-up update immediately after the row is created, so `pr_state` starts null; a forced resolve fires right after the write and fills in the live PR state, so the card shows its state chip without waiting for the background sweep.

`profile` is **mutually exclusive** with `agentOverride` / `modelOverride` / `effortOverride` / `permissionMode` / `runMode: "agent_override"`: a profile changes settings per column, those pin one value for the task's whole life. Passing both is rejected and nothing is created, rather than silently discarding one side (the repository enforces the same exclusivity on write). An unknown profile name is an error too - a typo must not quietly produce a task that looks tiered and runs on the plain board settings.

The mirror case is rejected for the same reason: any of the four pins alongside `runMode: "column_settings"`. Setting a pin already *is* asking for override mode, so pairing it with the opposite mode is a contradiction the repository would resolve silently in the pin's favour, discarding the mode the caller named. `runMode: "column_settings"` with no pins, or alongside `profile`, is fine - those agree.

If the target column has `auto_spawn` enabled, creating a task there will also spawn an agent session for it. Backlog items never auto-spawn.

**Branch conflict guard:** git allows a branch to be checked out in only one working tree at a time. When `branchName` names a branch that some worktree already holds - including the user's own main checkout - the tool refuses and creates nothing, rather than filing a task whose worktree can never be built. Without this guard the failure was invisible: the tool response is sent before auto-spawn runs, so the card appeared healthy while `git worktree add` failed a second later with `is already used by worktree at <path>`, leaving a null session and null worktree. The refusal names the branch and the path holding it, states that nothing was created, and says what to do - free the branch and re-run, or stop and tell the user, since the holder is often a checkout the calling agent cannot touch. The check is skipped for backlog items (which ignore `branchName`) and fails open if git cannot be probed. It is otherwise unconditional: it does not depend on the destination column's `auto_spawn` (a task filed into a quiet column today can be dragged into a spawning one tomorrow, and the conflict bites then), nor on `useWorktree` (passing `useWorktree: false` is rejected too, since that only moves the same collision to the branch-checkout step instead of avoiding it).

**Working in the project directory (`useWorktree: false`):** nothing is checked out. `ensureWorktree` reports `disabled` before it resolves a base branch or runs `git worktree add`, so no worktree is created, the user's working tree is untouched, and the agent runs with its cwd set to the project directory on whatever branch the repo currently has out. The reason is recorded on the task (`worktree_skip_reason`), and the task detail's folder button opens the project folder. `branchName` is still recorded on the task (and still subject to the branch conflict guard above, since the task can be moved into a worktree-creating column later), but it is not checked out. Omitting `useWorktree` follows the project's `worktreesEnabled` setting instead.

**Call-time override validation:** `agentOverride`, `modelOverride`, and `effortOverride` are validated when the task is created, not when it spawns. An unknown value is rejected immediately with the valid values listed, and no task is created. Previously a typo produced a task that looked correct on the board and failed hours later, when someone moved it into an executing column - far from the call that caused it.

The valid values come from the resolved agent's adapter-discovered `AgentCapabilities` (`models`, `effortLevels`, `supportsModelOverride`), unioned for models with the learned `discoveredModelsByAgent` cache the in-app model picker also uses. "Resolved agent" follows the normal ladder: `agentOverride` on the call -> the destination column's override -> the project default -> the app default. On [kangentic_update_task](#kangentic_update_task) there is one more rung between the call and the column, the task's own stored `agent_override`, which most tasks that have ever spawned carry; so an update is validated against the agent the task actually runs under, not the column's. The rejection names the resolved agent and where it came from, since the caller usually did not pass one, and that `resolved from` clause is the authoritative statement of which rung won.

Validation is deliberately permissive where it cannot know, in three ways:

- An agent that enumerates nothing accepts the value as given, and its CLI stays the final validator. This covers all three shapes of "nothing": the adapter does no capability discovery, the CLI is not installed (so discovery never runs), or the probe succeeded and found nothing - several agents have no effort flag at all, so their `effortLevels` is legitimately empty.
- A **floating model alias** (`"opus"`, `"sonnet"`) is always accepted. A discovered model list is built from concrete ids - Claude's comes from `message.model` in transcript history and from the CLI's own `/model` picker, both of which report full ids like `claude-opus-4-8` - so an alias is by construction absent from it even though `--model opus` is valid. Membership is therefore only enforced for a value carrying a trailing numeric version, which is exactly the shape the list enumerates. A mistyped or superseded concrete id (`claude-opus-4-9`) is still caught. The friendly family name the app displays for an alias (`"Sonnet"`) is stored as written, because a single word may be another agent's own model name; the Claude adapter turns it into `sonnet` at spawn when Claude's `/model` picker lists that family. It used to become `claude-sonnet`, which is not a valid id and passed here only to fail at spawn.
- **Spelling is normalized before the membership test.** One model is spawnable under several forms - `claude-opus-4-8`, the context-window variant `claude-opus-4-8[1m]`, and the dated pin `claude-opus-4-8-20260101` - and discovery records whichever form the transcript used, deliberately preserving a date rather than collapsing a pin to "latest". Both sides are therefore compared on the base id, with the `[1m]` suffix and any trailing date stripped, so a valid model is never rejected merely because the caller and the discovered list spell it differently.
- The capability probe is bounded; if it does not settle in time the value is accepted.

Only the fields present on the call are checked, so a later labels-only update never re-validates a task's stored pins.

**Labels with a long description:** when a call carries both a description of roughly 1KB or more and `labels`, the labels can be dropped before they reach the server. The drop happens upstream, in the MCP client's tool-call emission - Kangentic logs the raw request body before normalizing, and `labels` never arrives - so no handler or transport change can recover it. The workaround is a separate labels-only [kangentic_update_task](#kangentic_update_task) right after. The server detects the signature (no `labels` key in the received arguments alongside a large description) and appends a `[Labels not received]` line to the tool response naming the task to follow up on, so a caller learns about it without having to remember the limitation. On a backlog create the line names [kangentic_update_backlog_item](backlog-tools.md#kangentic_update_backlog_item) instead, since a backlog id does not resolve in `kangentic_update_task`. It is advisory, not an error: the task itself was created correctly, and a caller who deliberately sent no labels never sees the line, because the check is on the argument being *absent*, not empty.

**Cross-project routing guard:** when `project` is omitted (so the task would default to the active project) but the title or description names a *different* registered project, the tool refuses with a routing-check error instead of creating the task. No task is created and no rate-limit slot is consumed. Re-run with `project: "<that project>"` to file it there, or with `project: "<active project>"` to confirm the active project. This catches the common cross-project triage case (filing a bug about one project from another) when the routing cue is only implied by the task text.

Runaway-loop safeguard: a single Kangentic launch can create at most 500 tasks via this tool (a high internal circuit breaker against a misbehaving agent, shared across board and backlog, not a user-tunable setting). Hitting it returns a clear error and creates nothing; the accumulated count resets when Kangentic restarts.

## kangentic_update_task

Update a task's title, description (full replace, in-place find/replace edits, or append), PR info, agent assignment, model/effort/permission overrides, priority, labels, base branch, worktree toggle, the column automations switch, a workflow task's own plan approval, or attachments. To move a task between columns, use `kangentic_move_task` instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `title` | string | No | New title (max 200 chars) |
| `description` | string | No | New description, replaces the entire description (max 50000 chars). Mutually exclusive with `descriptionEdits` and `appendDescription`; for an incremental change to a long description, prefer those instead - they cost far fewer tokens and cannot silently drop untouched sections. |
| `descriptionEdits` | array | No | Ordered exact-string replacements applied to the current description, like the file `Edit` tool: `[{ find: string, replace: string }]` (1-100 edits; each `find`/`replace` up to 50000 chars). Each `find` must be present and unique in the text as it stands after prior edits in the list, or the whole call fails and nothing is written. Mutually exclusive with `description`; may combine with `appendDescription` (edits apply first). |
| `appendDescription` | string | No | Text appended to the end of the current description, exactly as given (no separator inserted, max 50000 chars). Mutually exclusive with `description`; may combine with `descriptionEdits` (edits apply first, then this append). |
| `prUrl` | string | No | Pull request URL (e.g. `https://github.com/owner/repo/pull/123`). This is what links the task to a PR; a URL written into `description` does not. |
| `prNumber` | number | No | Pull request number. The field the linker anchors on (Tier 1); derived from `prUrl` when omitted, so a URL-only write can never strand the previous PR's number. A number-only write leaves `pr_url` pointing at the previous PR until the immediate link-time resolve re-points it, which is harmless: the resolve follows the number you gave. |
| `agent` | string | No | Agent name to assign (e.g. `"claude"`, `"codex"`). Rejected if it is not a registered agent. Empty string clears. |
| `priority` | number | No | Task priority 0-4 (0=none, 4=highest) |
| `labels` | string[] | No | Replace the task's label list. Pass `[]` to clear. Call [kangentic_board_summary](task-read-tools.md#kangentic_board_summary) to see the board's existing label vocabulary. Subject to the same large-description drop as [kangentic_create_task](#kangentic_create_task), and the response carries the same `[Labels not received]` advisory when it happens. |
| `baseBranch` | string | No | Base branch the task's worktree branches from (e.g. `"main"`) |
| `useWorktree` | boolean | No | Whether the task uses an isolated git worktree. `false` means nothing is checked out - the agent runs in the project directory on whatever branch the repo currently has out. `true` is ignored while the project has worktrees turned off (Settings > Git). |
| `model` | string | No | Model override for this task (e.g. `"opus"`, `"claude-opus-4-8"`, or the friendly `"Opus 4.8"` / `"Opus"`). The same friendly-name handling (a name with a space converts, `"Opus"` is stored as written), then the same call-time validation [kangentic_create_task](#kangentic_create_task) applies. Pass empty string to clear. |
| `effort` | string | No | Effort/reasoning level override for this task (e.g. `"xhigh"`). Validated at call time against the resolved agent. Pass empty string to clear. |
| `permissionMode` | string | No | Permission mode override for this task: `"default"`, `"plan"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`, or `"auto"`. Pass empty string to clear. |
| `profile` | string | No | Board Profile this task rides (name or id) - an alternate set of per-column agent/model/effort settings, applied as the task moves. Pass empty string to clear it back to "Default". See [Board Profiles](profile-tools.md#board-profiles). |
| `runMode` | string | No | How the task gets its agent settings: `"column_settings"` (follow each column, clearing the model/effort/permissionMode pins) or `"agent_override"` (pin them for the task's whole life, clearing the profile). Setting any pin implies `"agent_override"`, so pass this only to switch modes without pinning anything; setting a pin alongside `"column_settings"` is rejected as a contradiction (pass the pin as an empty string to clear it instead). Omit to leave the task's current mode alone. |
| `attachments` | array | No | File attachments to ADD to the task: `[{ filePath: string, filename?: string }]`. Additive - existing attachments are kept, not replaced. Use `kangentic_remove_task_attachment` to remove one. |
| `automationsDisabled` | boolean | No | `true` pauses the task's column automations, `false` resumes them. While paused no column automation runs for it on any trigger and Kangentic approves none of its plans (an Automatic Plan approval waits for the user), so the board stops advancing it; manual moves, the column's agent settings and Run again still work. On a task in a workflow it also holds the task out of its workflow while the rest runs: the workflow does not judge, nudge, move or start it, and a hand may move its card to any column but To Do. The way for an agent to hold its own task while it waits on CI or a decision. Never restarts the session; resuming replays nothing that was skipped. Adding the task to a workflow resumes automations. Moving it out of Done or unarchiving it keeps them paused. See [Disabling automations for one task](../../architecture/automations/triggers.md#disabling-automations-for-one-task). |
| `planApproval` | string \| null | No | A workflow task's own plan approval: `"automatic"` or `"manual"` overrides its plan column for that task, and `null` follows the plan columns on its route again. The column's own value is stored as nothing. On a route with no plan column the value is kept as given and decides nothing until the route gains one. It goes through the same setter as the Workflows inspector, so the same refusals hold, each ending "The task was not updated.": a task in no workflow ("#88 is not in a workflow. Its column's Plan approval decides; change that with kangentic_update_column."), one that has passed its plan column ("#912 has passed Planning. Its plan approval can no longer change."), one in Done, and a workflow not started (set it on the planned task with [`kangentic_save_workflow`](workflow-tools.md#kangentic_save_workflow)). Written before any other field, so a refusal leaves the task as it was. A value that is none of the three is refused too. |

At least one updatable field is required.

`agent`, `model`, and `effort` get the same call-time validation as their `create_task`
counterparts (see [Call-time override validation](#kangentic_create_task)). Only the fields present
on the call are checked - a task's stored pins are never re-validated, so a labels-only follow-up
still succeeds on a task carrying a since-deprecated model.

A write that changes `model`, `effort`, `profile`, or `runMode` on a task with a running session
is applied to that session the way a ContextBar pick is: when the session runs at something other
than the new settings, it restarts with them as launch flags, in the background after the call
returns. A session already on the new settings is left alone, and so is one whose stored settings
the write did not change, such as a run mode sent again at its current value. The restart ends the session's
current turn, which is the caller's own turn when an agent updates its own task, and the reply says
so. See [Command Injection](../../architecture/automations/command-injection.md).

Setting `prUrl` or `prNumber` also clears the task's stored PR state and merge readiness, so the four PR columns never disagree; a forced resolve fires immediately after the write and fills both back in from the PR itself, so the card shows its state chip without waiting for the background sweep. The exception is a write that re-points nothing (the same `prUrl` and `prNumber` the task already holds, on a row whose `pr_state` is non-null): that is treated as a no-op, and both the clear and the resolve are skipped so the card's state chip does not blank and come back. See [PR linking](../pull-requests/pr-linking.md#where-pr-state-is-persisted).

`profile` is **mutually exclusive** with `model` / `effort` / `permissionMode` / `runMode:
"agent_override"` (and the task's `agent_override`): setting a profile clears the pins and forces
`runMode: "column_settings"`, and setting any pin clears the profile, so passing both in one call is
rejected rather than silently discarding one side. An unknown profile name is an error, not a fall
back to Default.

The mirror case is rejected too: a pin alongside `runMode: "column_settings"`, since a pin already
implies `"agent_override"`. The check is on truthiness, not presence, so the empty-string CLEAR
sentinel still pairs legally with `"column_settings"` - clearing a pin and following the columns
agree, and that is the natural way to write "stop pinning this and go back to the columns".

## kangentic_link_pr

Authoritatively resolve and link the pull request for a task through the repository's PR host (GitHub via `gh`, Azure DevOps via `az`), walking the confidence ladder in `docs/integrations/pull-requests/pr-linking.md`: PR number, worktree branch, commit, stored branch, pushed branch, remote tip. Unlike the terminal-scraping auto-linker, this finds PRs opened by a human, the web UI, `git push`, scripts, or the host API, and works even when the task has no live session. Re-running refreshes the linked PR's state (`open`/`draft`/`merged`/`closed`) and merge readiness (`ready`/`blocked`/`conflicting`/`queued`/`running`/`unknown`, see [PR connector model](../pull-requests/connector-model.md#merge-readiness)). Use after opening a PR, or to backfill a task whose PR was never linked.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `branch` | string | No | The remote branch the work was pushed to (the PR source branch). Recorded as the task's `pushed_branch` before resolving. A task with no worktree has nothing to search by until a push is recorded, so pass this when the auto-capture from the agent's own `git push` did not fire |
| `project` | string | No | Project selector to target a different project |

Returns the linked PR (number, url, state, merge readiness) on success. The reply's `, merge <readiness>` note is left off for a merged or closed PR (`prReadinessNote`, `src/main/pr/pr-readiness-note.ts`, shared with the linker's log line), since only an open or draft PR has a merge to be ready for. A merged PR used to read "merged, merge unknown", which an agent took as a merge still in doubt. "Searched and found nothing" is a normal result naming the anchors it searched by. "Nothing to search by" (no PR number, worktree, branch, commit, or pushed branch on the task) is a refusal with `isError: true` that names the two remedies: pass `branch`, or set `prUrl` / `prNumber` with `kangentic_update_task`. A resolver that is unavailable or errored transiently is a refusal too.

## kangentic_move_task

Move a task to a different column, optionally placing it at a chosen slot in that column. Triggers the same lifecycle as a UI drag: spawning/suspending agents, creating/cleaning up worktrees, and running configured transition actions. Moving to the Done column auto-archives the task, and moving OUT of Done un-archives it again so it returns to the board. Moving to To Do kills the session, removes the worktree, and drops the PR link of a task that did its own work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `column` | string | Yes | Target column name (case-insensitive, e.g. `"Review"`, `"Done"`), or `"next"` for the column after the task's current one. A column literally named "next" wins. |
| `position` | number | No | Zero-based ordinal slot among the column's tasks (not a raw stored position); the tasks at and below it shift down. Clamped to the column, so a value past the end lands last. Omit to append to the end of the column, which is the default. |
| `message` | string | No | A message for the agent in the destination column (up to 20,000 characters, line breaks kept). It is delivered once that agent's turn ends, after the column's own On task enter automations, so the move and its hand-off are one call: a separate `kangentic_send_session_message` cannot reach a session the move itself is suspending or starting. When no agent runs where the task lands (a column that starts none, a paused agent), the message is held for the task's next agent ([Held messages](../../architecture/sessions/held-messages.md)); a move into Done holds nothing and drops it. When the move resumes the task's main conversation after isolated column sessions, a message leaves those sessions' final messages out of the return recap, since it usually repeats the last one ([Resume](../../architecture/sessions/resume.md)). Refused on a move that stays in the task's column, except from the task's own agent (see below). |

Naming the task's **current** column together with `position` repositions it in place. That path is
presentation only: it does not change the task's column, session, worktree, or `session_id`, and it
deliberately does not run the move lifecycle at all - so it cannot disturb a drag the user has in
flight for the same card. Repositioning counts slots among the *other* tasks in the column, so
`position: 0` is the top and the highest legal slot is one less than the column's length; moving
*into* a different column counts slots among that column's existing tasks, where the column's length
is the appending slot.

`position` has no useful effect when moving into Done, which archives the task and takes it off the
board.

Naming the task's current column with no `position` moves nothing and answers `Task "<title>" is
already in <column>.` That is a success, not an error, so an agent that repeats a move it already
made gets a harmless answer. A `message` on that call is refused for any caller but the task's own
agent, which gets the same answer plus "Nothing moved, so the message was not sent."

`column: "next"` resolves from where the task is now. For the task's own agent it is first checked
against the column the agent's current turn began in: the turn's start, from its spawn or from new
input (`SessionManager.workTurnStartedAt`), and the column the task's last recorded move before that
instant took it to (`TaskMoveRepository.columnAt`). A plan approval does not move that start. When
the task has since left that column, "next" is refused, because the agent judged the earlier
column's work done and "next" from the new one would skip a column. That happened to #919: its
plan approval moved it from Planning to Executing while the same turn carried on, and the turn's
"next" landed it in Code Review. The refusal names both columns:

- In a column that carries the session on (main, resumes its conversation): `#919 already moved
  from Planning to Executing, so this turn is doing Executing's step now. When that work is done,
  move it with column "Code Review".` A workflow task is also told it can end its turn and let the
  workflow move it.
- In a column that ends the session (Done, To Do, no agent, isolated or always fresh), such as a
  repeated "next" after the agent's own move: `#919 already moved from Executing to Code Review.
  Your session ends when this turn does.`

Another task's agent, a caller with no session, a session with no turn yet, and a task with no
recorded move by the turn's start resolve "next" as before. A column named outright is never
refused this way. Any move under a live turn counts, a person's drag or an automation's included,
even when the destination's column message reaches the agent inside that same turn: the turn
began in the earlier column, and the refusal names the column to move to.

When the task's own agent moves it and the move ends that agent's session (Done, a column with no
agent, an isolated or always-fresh column, an agent or model change), the session ends only after
the turn that made the call, up to 30 seconds. The call and its result then stay in the agent's own
conversation, so a later resume of that conversation does not make the move again. The reply tells
the agent: "Your session ends when this turn does." for Done or a column with no agent, and "If
<column> starts a session of its own, yours ends when this turn does." otherwise. See
[A call that ends the caller's own session](../../architecture/sessions/suspend-and-cleanup.md#a-call-that-ends-the-callers-own-session).

To re-sequence several tasks at once, use [kangentic_reorder_tasks](#kangentic_reorder_tasks).

## kangentic_reorder_tasks

Set the order of tasks within one column, top to bottom, in a single atomic call. This is the tool
for sequencing a column by priority or execution order ("order To Do so the auth work comes first").

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name whose tasks are being reordered (case-insensitive) |
| `taskIds` | string[] | Yes | Task IDs (numeric display IDs or full UUIDs), in the order they should appear from the top. Every ID must already be in that column. |
| `project` | string | No | Project selector to target a different project |

**Prefix semantics.** The listed tasks take the top slots in the order given; any task in the column
you do not list keeps its relative order below them. So passing every ID sets the column's full
order, and passing three IDs pins those three to the top. Being a prefix rather than a strict
full-list contract is what makes the call safe against a live board: a task created between your
read and your write simply sinks below the ones you named instead of failing the call.

Read the current order first with [kangentic_list_tasks](task-read-tools.md#kangentic_list_tasks) or
[kangentic_get_column_detail](column-tools.md#kangentic_get_column_detail).

Reordering is presentation only. It never changes a task's column and never spawns, suspends, or
otherwise touches a session or worktree - use [kangentic_move_task](#kangentic_move_task) to change
a task's column. An ID that names a task in another column (or an archived one) is rejected rather
than silently moved. Duplicate IDs are rejected too.

Returns the column's resulting order as `{ id, displayId, position }` entries; the rendered message
echoes the first 25 display IDs.

## kangentic_delete_task

Permanently delete a task from the board. Removes the task, its attachments, and session records. The associated worktree and branch may also be cleaned up. This cannot be undone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID like `"42"` or full UUID). |

Find task IDs with `kangentic_find_task` or `kangentic_search_tasks`.

## kangentic_remove_task_attachment

Remove one attachment by its attachment ID, from a board task or a backlog item - the ID alone determines which surface owns it. This cannot be undone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `attachmentId` | string | Yes | Attachment UUID (board `task_attachments.id` or backlog `backlog_attachments.id`) |

Find attachment IDs with `kangentic_query_db`, e.g. `SELECT id, filename, task_id FROM task_attachments` for board tasks, or `SELECT id, filename, backlog_task_id FROM backlog_attachments` for backlog items.
