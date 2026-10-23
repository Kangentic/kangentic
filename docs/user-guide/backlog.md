---
type: Guide
title: Backlog
description: "The backlog staging view: creating and editing items, labels and the priority scale, filtering, bulk Move to Board, drag reorder, and Import, which pulls GitHub Issues, GitHub Projects and Azure DevOps items through the gh and az CLIs with incremental sync and duplicate detection."
tags: [backlog, import, labels, priorities]
sources:
  - resource: src/renderer/components/backlog/
---
# Backlog

The Backlog is a staging area for tasks before they reach the board. Switch between **Board** and **Backlog** views using the tabs at the top. The Backlog tab shows how many items the backlog holds, and no count when it is empty.

Both views share one toolbar row, and it adapts to the space it has. As the window narrows or the
sidebar widens, its controls drop their text and become icons in the same positions, keeping the
label as a tooltip. Nothing is hidden and nothing moves, so every control named below is still
where this guide says it is, just narrower. At the smallest window size the whole row is icons.

## Creating Items

Click **New Task** in the backlog toolbar to create a backlog item with a title, description, priority, labels, and optional file attachments. You can paste or drag-and-drop any file type as an attachment.

## Editing Items

Double-click any row to open it for editing. You can also click the pencil icon in the row's action buttons, or right-click and select **Edit** from the context menu.

## Labels

Click **Labels** in the toolbar to manage labels. Labels are free-form text tags added during item creation or editing. From the Labels popover you can rename a label across all items, delete a label, and assign colors to labels for visual distinction. Labels and their colors are shared between the backlog and the board.

## Priorities

Click **Priorities** in the toolbar to manage the priority scale. The default scale is None, Low, Medium, High, Urgent (0-4). You can rename priority levels, reorder them, add new ones, or remove existing ones. Priority colors are customizable.

## Filtering

Click **Filter** to filter by priority level and/or label. While filters are active, the Filter button shows how many, right after its label. Use the search bar to filter items by title, description, or label text.

## Multi-Selection & Bulk Operations

Click a row to select it, or use the checkboxes. The header checkbox selects/deselects all visible items. When multiple items are selected, a bulk toolbar appears at the bottom with **Move to Board** and **Delete** actions. Right-clicking with multiple items selected shows a context menu that operates on the entire selection.

## Context Menu

Right-click any backlog row to open a context menu with:
- **Move to Board** - submenu listing all available columns as targets
- **Edit** - open the item for editing
- **Delete** - permanently remove the item

When multiple items are selected and you right-click one of them, the context menu operates on all selected items (e.g., "Move 5 to Board", "Delete 3 items").

## Drag to Reorder

Drag rows by the grip handle on the left to manually reorder items, or Tab to the grip and use Space and the arrow keys. Drag-to-reorder is available when no column sort is active. When you sort by a column header (priority, title, created date), manual reorder is disabled until the sort is cleared.

## Promoting to the Board

Select one or more items using the checkboxes, then click **Move to Board** in the bulk toolbar that appears at the bottom. Choose a target column and the items become board tasks. If the target column has auto-spawn enabled, an agent session starts immediately. You can also promote individual items using the arrow icon in the row action buttons or the context menu.

## Importing from External Sources

Click **Import** in the backlog toolbar to pull tasks from external project management tools.

**Supported sources:**
- **GitHub Issues** - import issues from any GitHub repository
- **GitHub Projects** - import items from a GitHub Project board
- **Azure DevOps Work Items** - import work items from Azure DevOps boards, sprints, or backlogs
- **Asana** - import tasks from an Asana project (its list, board, or calendar view URL)

**Prerequisites:**
- **GitHub:** The `gh` CLI must be installed and authenticated. For GitHub Projects, the `project` scope is required (`gh auth refresh -s project`).
- **Azure DevOps:** The `az` CLI must be installed, authenticated (`az login`), and the azure-devops extension installed (`az extension add --name azure-devops`).
- **Asana:** a Personal Access Token, created at `app.asana.com/0/my-apps`. The first time you pick Asana, a setup dialog asks for it, checks it against Asana, and stores it encrypted on this machine.

**Adding a source:**
1. Click **Import** > **Add Source**
2. Choose a provider (GitHub, Azure DevOps, or Asana) and source type
3. Paste the full URL (e.g., `https://github.com/owner/repo`, `https://github.com/orgs/owner/projects/1`, `https://dev.azure.com/org/project`, or `https://app.asana.com/0/1234567890/list`)
4. Click **Connect** - Kangentic verifies CLI authentication and saves the source
5. For Azure DevOps sprint URLs, items are automatically scoped to that sprint's iteration path

**Importing items:**
1. Click a saved source to open the import dialog
2. Browse items with filtering by ID, title, type, status, assignee, and labels (the search box
   matches only what a row displays, so every hit is explainable from the row itself)
3. Use the "Imported" toggle to hide already-imported items (on by default)
4. Click anywhere on a row to select it (or use the checkbox)
5. Click **Import (N)** to pull selected items into the backlog

The dialog opens from a per-project cache of the source's items, so the list paints at once, and a
"Syncing..." line at the bottom shows while it fetches only the items changed since the last sync in
the background. The cache survives an app restart and a project switch. The **Open / Closed / All**
toggle filters that cache on the spot, without another fetch. If the sync fails, the error banner
carries a **Retry**; once every item is imported, **Refresh to check for new items** on the empty
state refetches the whole source rather than only the changes.
See [Board integration](../integrations/boards.md) for the adapter contract behind the incremental
fetch.

Imported items include the title, description (markdown), labels, and assignee from the source. Inline images in issue bodies are downloaded as backlog attachments. A small GitHub icon appears on imported items linking back to the original ticket.

Items that have already been imported are detected by `external_source` + `external_id` and shown with a checkmark. Re-importing the same source skips duplicates automatically.

Saved sources persist in `.kangentic/config.json` per project and appear in the Import dropdown for quick re-syncing.
