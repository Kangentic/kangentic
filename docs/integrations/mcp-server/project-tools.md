---
type: Reference
title: Project tools
description: How the optional project parameter routes any MCP tool call to another registered project, the response prefix that confirms where a call landed and its exceptions, and kangentic_list_projects and kangentic_move_task_to_project (To Do tasks only, rolled back if an attachment fails to copy).
tags: [mcp, projects, routing]
sources:
  - resource: src/main/agent/mcp-http/project-tools.ts
  - resource: src/main/agent/mcp-http/project-resolver.ts
  - resource: src/main/agent/mcp-http/task-tools.ts
    title: kangentic_move_task_to_project registration
---
# Project tools

## Cross-Project Calls

Every Kangentic MCP tool accepts an optional `project` parameter, with two deliberate exceptions: `kangentic_get_current_task` (it resolves the project from the caller's own worktree) and the whole `kangentic_browser_*` family (see [Browser automation tool surface](browser-panes.md#browser-automation-tool-surface-kangentic_browser_): no argument names another project, and driving is confined to the connection's own, with `kangentic_browser_close_pane`'s `includeOtherProjects` the one opt-in that reaches beyond it). Use it to route a tool call at a *different* Kangentic project than the one the MCP client is bound to - no need to switch projects in the UI or reconfigure MCP.

| Parameter | Type | Description |
|-----------|------|-------------|
| `project` | string | Project name (case-insensitive exact) or project UUID. Omit to target the active project. |

When `project` is set the tool response is prefixed with `[Project: <name> (<shortId>)]` so the caller can confirm where the action landed. `kangentic_create_task` always emits this prefix, including when it falls back to the active project, so a misrouted create is visible up front. Column resolution, `baseBranch` / `branchName` / `useWorktree`, auto-spawn side effects, and session lookups all apply against the *target* project.

`kangentic_get_current_task` is intentionally excluded: it resolves the agent's own CWD/branch, so cross-project lookup makes no sense there.

`kangentic_move_task_to_project` is also excluded from the `[Project: ...]` prefix: it resolves two projects at once (source via `project`, destination via `targetProject`) rather than routing a single call through one target, so its response message already states the source and destination context directly (e.g. "was #7 ... now #12 in the To Do column").

Use `kangentic_list_projects` (below) to discover valid selectors.

### kangentic_list_projects

List every Kangentic project registered on this machine. Use the returned name or id as the `project` argument on any other `kangentic_*` tool.

No parameters. Returns each project's `name`, `id`, `path`, `lastOpened` timestamp, and an `isActive` flag marking the project the MCP client is bound to.

### kangentic_move_task_to_project

Relocate a task from the To Do column of one project's board to a different project's board. Only tasks in To Do can be moved - a task outside To Do may have a live session or worktree that cannot cross projects, so move it to To Do first (the tool also rejects a nominally-To-Do task that still has a live `session_id` or an on-disk worktree, as a defensive check). It also refuses a task that is still in a workflow, and names [kangentic_remove_from_workflow](workflow-tools.md#kangentic_remove_from_workflow) as the way out; a task whose workflow was deleted is not in one, so it moves. Preserves title, description, labels, priority, creation time, attachments, and whether its column automations are disabled; assigns a new task ID and display number in the target project. Lands in the target board's To Do column by default. Landing in an `auto_spawn`-enabled `column` on the destination board spawns an agent there, the same as `kangentic_create_task`. `targetProject` must differ from the resolved source project - a same-project call is rejected with a pointer to `kangentic_move_task` instead. If any attachment fails to copy to the destination, the whole move is rolled back (the newly-created target task and its copied attachments are removed) and the source task is left untouched, so a partial-copy failure never duplicates or loses a task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) of the To Do task in the source project |
| `targetProject` | string | Yes | Destination project name (case-insensitive) or UUID. Must differ from the source project. |
| `column` | string | No | Target column on the destination board (case-insensitive). Defaults to the destination board's To Do column. The destination's done-role column is refused, the same way [kangentic_create_task](task-tools.md#kangentic_create_task) refuses it. |
| `project` | string | No | Source project name (case-insensitive) or UUID - not the destination. Omit to target the active project. |
