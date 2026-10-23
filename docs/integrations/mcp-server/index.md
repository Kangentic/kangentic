# MCP server

## Server

* [How the MCP server works](how-it-works.md) - How the in-process MCP HTTP server authenticates (per-launch X-Kangentic-Token, loopback bind, DNS rebinding allowlist, caller URL segment), how each agent CLI receives its config, how tool annotations drive plan-mode approval, and the enable switch, permissions and 401/404 troubleshooting.

## Tasks and board

* [Task tools](task-tools.md) - Parameters and guards for creating, updating, moving, reordering, deleting and PR-linking board tasks over MCP: kangentic_create_task's call-time override validation, branch conflict guard and 500-task cap, update_task description edits, and move_task slots and message hand-off.
* [Task read tools](task-read-tools.md) - Read-only MCP tools for tasks and board totals: list_tasks ordinal positions, find_task by display ID, branch or PR number with Knowledge Graph lines, get_current_task from a worktree, board_summary label vocabulary, and get_task_stats and get_usage_stats cost, token and subagent fan-out figures.
* [Search tools](search-tools.md) - kangentic_search's unified keyword and semantic search over tasks, backlog, session events, conversations, commits and projects, with groupBy task and relatedToTask rankings, the Ask caller's four-search budget, and the board-scoped kangentic_search_tasks.
* [Column tools](column-tools.md) - Reading and editing board columns over MCP: list_columns and get_column_detail output, update_column and create_column parameters (autoSpawn, session track, planApproval, model and effort overrides), the cross-project no-reconcile rule, and what delete_column refuses.
* [Backlog tools](backlog-tools.md) - MCP tools for the backlog staging area: list_backlog filters, promote_backlog into a board column with attachment copying, the replace-versus-additive rules for labels and attachments in update_backlog_item, and delete_backlog_item.
* [Board profile tools](profile-tools.md) - Board Profiles over MCP: named per-column agent, model and effort presets stored in kangentic.json and keyed by column name, the omit, null and value three-state rule, merge versus replaceColumns, and the live-session effects of editing or deleting a profile.
* [Project tools](project-tools.md) - How the optional project parameter routes any MCP tool call to another registered project, the response prefix that confirms where a call landed and its exceptions, and kangentic_list_projects and kangentic_move_task_to_project (To Do tasks only, rolled back if an attachment fails to copy).

## Automation and workflows

* [Column automation tools](automation-tools.md) - Column automations over MCP: the five automation types and their fields, the condition, finalLine and maxRuns guards, which rows can never run and why, and the list_automations, set_automations, get_automation_runs and run_automation tools.
* [Workflow tools](workflow-tools.md) - Workflows over MCP: routes and blockers, the task lock while a workflow runs, save, start, pause, resume and delete, adding, linking and rerouting tasks, and request_project_access for a workflow's own agent.

## Sessions and diagnostics

* [Session tools](session-tools.md) - MCP tools for inspecting and steering agent sessions: list_sessions, get_transcript formats and views, session files, events and activity intervals, send_session_message delivery modes and loop guards, mark_background_service, and reserve_dev_ports and check_dev_ports.
* [Diagnostics tools](diagnostics-tools.md) - Read-only MCP tools for debugging Kangentic itself: query_db under query_only, tail_logs, get_recent_crashes, get_process_metrics, get_ipc_log (needs developer.recordIpcTraffic) and list_worktrees with ahead and behind counts.

## Browser

* [Browser panes](browser-panes.md) - How agents open, list, close, pop out and resize the embedded Browser pane over MCP: surface handles and surface-gone, the one-surface-per-task rule with its offscreen lane fallback and hand-off, Agent Browser gating, and set_viewport's zoom-to-fit emulation.
* [Browser actions](browser-actions.md) - The kangentic_browser_* tools that act on the loaded page: navigate, screenshot, DOM queries, console, network, click, type, keypress, drag, scroll, file drop, dialogs and eval, with their parameters, capability tiers and error kinds.

## Development

* [Dev-only inspection tools](devtools.md) - The dev-only kangentic_devtools_* MCP tools for inspecting a running preview instance: store and engine state, DOM and React queries, event-loop lag, terminal forensics and PTY input, and the gates that keep them out of production builds.
