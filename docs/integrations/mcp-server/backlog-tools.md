---
type: Reference
title: Backlog tools
description: "MCP tools for the backlog staging area: list_backlog filters, promote_backlog into a board column with attachment copying, the replace-versus-additive rules for labels and attachments in update_backlog_item, and delete_backlog_item."
tags: [mcp, backlog]
sources:
  - resource: src/main/agent/mcp-http/session-tools.ts
    title: Backlog tool registrations
  - resource: src/main/agent/commands/backlog-commands.ts
---
# Backlog tools

## kangentic_list_backlog

List items in the backlog staging area. Items have priority levels and labels for organization.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `priority` | number | No | Filter by priority: 0=none, 1=low, 2=medium, 3=high, 4=urgent |
| `query` | string | No | Search keyword to filter by title, description, or labels |

## kangentic_promote_backlog

Move backlog tasks to the board, creating tasks in the specified column. The done-role column is refused, the same way [kangentic_create_task](task-tools.md#kangentic_create_task) refuses it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `itemIds` | array | Yes | Backlog task IDs to move |
| `column` | string | No | Target column name. Defaults to To Do. |

Attachments on promoted backlog tasks are automatically copied to the new task. Find item IDs with `kangentic_list_backlog` or `kangentic_search_tasks` (with `scope: "backlog"`).

## kangentic_update_backlog_item

Update a backlog item's title, description, priority, labels, or attachments. Only the fields you provide are changed; omitted fields are left as-is. The `labels` parameter is a full replacement (not additive) - pass the complete new label set. `attachments` is additive - existing attachments are kept, not replaced.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `itemId` | string | Yes | Backlog item UUID |
| `title` | string | No | New title (max 200 characters) |
| `description` | string | No | New description (max 10,000 characters) |
| `priority` | number | No | New priority: 0=none, 1=low, 2=medium, 3=high, 4=urgent |
| `labels` | array | No | Full replacement label set. Strings, or `{name, color}` objects to also set the label color. |
| `attachments` | array | No | File attachments to ADD to the item: `[{ filePath: string, filename?: string }]`. Additive - existing attachments are kept. Use `kangentic_remove_task_attachment` to remove one. |

Find item IDs with `kangentic_list_backlog` or `kangentic_search_tasks` (with `scope: "backlog"`).

## kangentic_delete_backlog_item

Permanently delete a backlog item and all of its attachments. This cannot be undone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `itemId` | string | Yes | Backlog item UUID to delete |

Find item IDs with `kangentic_list_backlog` or `kangentic_search_tasks` (with `scope: "backlog"`).
