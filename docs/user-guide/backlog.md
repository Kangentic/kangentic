---
type: Guide
title: Backlog
description: "The backlog staging view: creating and editing items, labels and the priority scale, filtering, bulk Move to Board, drag reorder, and Import, which pulls GitHub Issues, GitHub Projects, Azure DevOps, Asana, Jira, Linear, Trello and GitLab items, and Obsidian notes and checklist items, with incremental sync and duplicate detection."
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

Click **Priorities** in the toolbar to manage the priority scale. The default scale is None, Low, Medium, High, Urgent (indices 0 to 4; a scale you extend has more, and agents set a level by its index). You can rename priority levels, reorder them, add new ones, or remove existing ones. Priority colors are customizable.

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
- **Jira** - import issues from a Jira Cloud or Data Center board, project, saved filter, or JQL query
- **Linear** - import issues from a Linear team, picked from a list of your teams
- **Trello** - import cards from a Trello board, picked from a list of your boards
- **GitLab** - import issues from a GitLab project or group, on gitlab.com or your own GitLab server
- **Obsidian Notes** - import each note in a folder of an Obsidian vault as a task
- **Obsidian Checklist items** - import each task line in a folder's notes (`- [ ]`, and the done, in-progress and cancelled marks) as a task

**Prerequisites:**
- **GitHub:** The `gh` CLI must be installed and authenticated. For GitHub Projects, the `project` scope is required (`gh auth refresh -s project`).
- **Azure DevOps:** The `az` CLI must be installed, authenticated (`az login`), and the azure-devops extension installed (`az extension add --name azure-devops`).
- **Asana:** a Personal Access Token, created at `app.asana.com/0/my-apps`. The first time you pick Asana, a setup dialog asks for it, checks it against Asana, and stores it encrypted on this machine.
- **Jira:** a sign-in for the site, asked for the first time a link names it. **Connect Jira** asks the site whether it runs Cloud or Data Center. Jira Cloud takes your Atlassian email and an API token (created at `id.atlassian.com`; a token with scopes works too, and needs the Jira Software board scopes to read boards). Jira Data Center offers two ways in: a personal access token from your Jira profile, or your username and password. The sign-in is checked against Jira and stored encrypted on this machine, one per site. A build that carries Kangentic's Atlassian client id also offers **Sign in with Atlassian** for Jira Cloud, beside the API token: it opens Atlassian's approval page in your browser and waits there ("Waiting for Atlassian in your browser", with **Open the page again** for a tab you closed). Approving Kangentic closes the dialog. If you decline, or your account can't open the site ("This sign-in can't open acme.atlassian.net."), the dialog goes back to the two choices with the reason. A browser sign-in renews itself, but after 90 days without an import Atlassian asks you to sign in again. The sign-in and every renewal go through Kangentic's sign-in service at kangentic.com, which holds the secret Atlassian requires and seals the tokens to this computer before they reach your browser.
- **Linear:** the first time you pick Linear, **Connect Linear** asks for a personal API key. Create
  one in Linear under Settings > Account > Security & Access (Read access is enough), paste it, and
  Kangentic checks it against Linear and stores it encrypted on this machine. A build that carries a
  Linear OAuth client id also offers **Sign in with Linear** beside the key: it opens Linear's
  approval page in your browser, and approving Kangentic closes the dialog. A browser sign-in renews
  itself, but after 30 days without an import Linear asks you to sign in again.
- **Trello:** the first time you pick Trello, **Connect Trello** asks for an API key and a token.
  Make a Trello app at `trello.com/apps/admin`, generate its API key on the app's Trello Auth tab,
  and paste it. **Open Trello's approval page** then asks Trello for a read-only token that never
  expires, and Trello shows it for you to paste. Kangentic checks both against Trello and stores
  them encrypted on this machine. A build that carries Kangentic's own Trello key also offers
  **Sign in with Trello**, which skips making an app and the paste: approve Kangentic in your
  browser and the dialog closes on its own. A declined approval goes back to the two choices with
  the reason.
- **GitLab:** a sign-in for the server, asked for the first time a link names it. **Connect GitLab**
  takes a personal access token with the `read_api` scope: its first step opens your server's access
  token page with the name and scope filled in. On gitlab.com, a build that carries Kangentic's
  GitLab OAuth client id also offers **Sign in with GitLab** beside the token, which approves
  Kangentic in your browser and renews itself. A self-managed server offers the token only. The
  sign-in is checked against GitLab and stored encrypted on this machine, one per server. GitLab
  tokens always expire (365 days at most), so expect to connect again when yours does.
- **Obsidian:** nothing to install or sign in to. The vault is read from this computer, also for a
  remote project, and Kangentic never writes to it.

**Adding a source:**
1. Click **Import** > **Add Source**
2. Choose a provider (GitHub, Azure DevOps, Asana, Jira, Linear, Trello, GitLab, or Obsidian) and source type (GitHub has Issues and Projects, Obsidian has Notes and Checklist items)
3. Paste the full URL (e.g., `https://github.com/owner/repo`, `https://github.com/orgs/owner/projects/1`, `https://dev.azure.com/org/project`, or `https://app.asana.com/0/1234567890/list`). For Jira, paste a board, project, saved filter or search link (`https://your-site.atlassian.net/jira/software/projects/ENG/boards/12`, `.../browse/ENG`, `.../issues/?filter=10021`, `.../issues/?jql=...`), or type JQL, which runs on your one connected Jira site. With more than one Jira site connected, typed JQL does not say which to use, so the popover asks for a search link instead ("Paste a search link so the site is known."). For GitLab, paste any project, group, issue list, issue or board link (`https://gitlab.com/acme/web`, `https://gitlab.com/groups/acme/-/issues`, `https://gitlab.com/acme/web/-/boards/12`); filters in the link are dropped. A link on a server that is not GitLab is refused ("github.com is not a GitLab instance."). Linear lists your teams instead, and Trello your open boards under their Workspace: click one. One you already added says **Added** and opens its source. Obsidian opens the folder dialog instead: choose the vault, or any folder inside it, and the source is saved and opened at once.
4. Click **Connect** - Kangentic verifies authentication and saves the source. For Jira it also checks that the account can open the board, project or filter, and names the source after it. For GitLab it checks that the account can open the project or group (and the board a board link names), and names the source by its path. The saved source says whether it is a project or a group, and names a self-managed server ("GitLab Group on git.example.com").
5. For Azure DevOps sprint URLs, items are automatically scoped to that sprint's iteration path

An Obsidian vault is the folder that holds `.obsidian`. Choose a folder inside one and Kangentic
finds the vault above it; the source reads that folder and its subfolders. A source is named for
the vault, then the folder (`Work: Projects`), and its row's tooltip shows the full path. A folder
in no vault is refused with "Not in a vault" and nothing is saved. To import both notes and
checklist items from one vault, add it twice, once with each type.

If a saved sign-in stops working (a revoked Asana token, Jira token, Linear key, Trello token or
GitLab token, or a Linear or Atlassian sign-in that lapsed), the import dialog's error banner carries a **Connect Asana**,
**Connect Jira**, **Connect Linear**, **Connect Trello** or **Connect GitLab** button. It reopens the setup dialog
the way you signed in: Sign in with Atlassian starts the browser sign-in again, and a Jira token
reopens its steps with the site and email filled in, as a GitLab token does with the server. Once the new credential works the dialog syncs.
If Atlassian or Kangentic's sign-in service is down, a browser sign-in is kept and the banner offers
**Retry** instead. If an Obsidian source's folder moved, its drive is gone, or it is no longer
inside a vault, the banner says "Folder not found" or "Not in a vault" and carries **Choose
folder**, which saves the new folder in the old source's place. Items already imported still read as imported. Choosing the same folder
again checks it again in place.

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
carries a **Retry**, or a **Connect** button when the sign-in itself has stopped working (a token
revoked mid-session): the dialog checks the sign-in again after a failed sync to choose. Once every
item is imported, **Refresh to check for new items** on the empty
state refetches the whole source rather than only the changes.
See [Board integration](../integrations/boards.md) for the adapter contract behind the incremental
fetch.

Imported items include the title, description (markdown), labels, and assignee from the source. Inline images in issue bodies are downloaded as backlog attachments. A small icon beside an imported item's title opens the original ticket: the GitHub mark for a GitHub import, a link icon for every other source. For an Obsidian import it opens the note's file in your system's app for markdown.

Linear issues show their own ids (`ENG-214`) in the dialog, and the Status filter lists the team's
states in the order its board shows them. An imported Linear issue keeps its priority when the
project's scale still has a level of the same name (Urgent, High, Medium or Low). With no priority
in Linear, or no level of that name in the project, it imports at the bottom level. Its project, cycle, estimate and due date go into a **Linear** section at
the end of the description.

Jira issues show their keys (`ENG-142`) in the dialog, and for a board source the row's status and
the Status filter use the board's own column names, in board order. A Jira or Azure DevOps item
also brings its comments, its type and its due date. A Jira priority matches your priority scale by
name the same way, and Jira's Highest and Lowest, which no stock scale has, take the top level and
Low.

Trello cards show their card number (`#138`) in the dialog, and the Status filter lists the
board's lists left to right. Trello cards have no open or closed state, so **Closed** means an
archived card or a card on an archived list. A card on a list named Done is still **Open**, so
untick that list in the Status filter to leave it out. A label with a color and no name imports as its color
(`green`), checklists become task lists in the description, and the card's list, members, start
and due dates and saved links go into a **Trello** section at the end. Uploaded files come over as
attachments.

GitLab issues show `#214` for a project source and GitLab's group-relative id (`web#214`) for a
group source. A group source covers its subgroups and, like GitLab's own list, leaves out archived
projects. GitLab has no status field, so the Status filter follows the source's issue board: Open,
then the board's label lists left to right, then Closed. A board link picks that board; otherwise
it is the board GitLab treats as default, first by name. Issues, tasks and incidents all import, and
the Type filter tells them apart. GitLab issues have no priority, so they import at the bottom
level. Labels come over as written, scoped labels (`workflow::doing`) included, and milestone,
iteration, weight, due date and assignees go into a **GitLab** section at the end of the
description. Images in a GitLab issue download with your sign-in on GitLab 17.4 and later; on an
older server they stay as links.

### What an Obsidian note or item becomes

Only the properties and markers named here are read. Folders whose name starts with a dot
(`.obsidian`, `.trash`, `.git`), the folder the Templates core plugin uses, and any note over 5 MB
are skipped.

| | A note (Notes source) | A checklist line (Checklist items source) |
|---|---|---|
| Title | the `title` property, else the file name | the line without its checkbox, Tasks plugin fields, tags and block id |
| Labels | the `tags` property and the `#tags` in the text | the `#tags` on the line |
| Priority | the `priority` property, matched by name to the project's scale | the Tasks plugin marker: 🔺 Urgent, ⏫ High, 🔼 Medium, 🔽 and ⏬ Low |
| Closed | `status` is done, complete, completed, closed, cancelled or canceled | `[x]` or `[-]` |
| Status filter | the `status` value, or No status | To do, In progress, Done or Cancelled |
| Description | the body, then the other properties under **## Obsidian** | the line as written, then the note and heading it sits under |

The dialog shows a note's folder (`Projects/`), or a line's note, where other sources show an id.
A Kanban plugin board file is read by a Checklist items source only: each `##` lane is a card's
status, the Status filter lists the lanes in board order, and cards in the lane marked Complete are
closed.

A note is matched across re-imports by its path in the vault, and a checklist line by its block id
(`^abc123`) or, without one, by its words. Editing a note, ticking a line, adding a date or moving a
card to another lane keep the match. Renaming or moving a note, or rewording a line with no block
id, makes a new row; the task imported before stays as it was.

Every file a note embeds (`![[file]]` or `![](file)`) is copied in as an attachment, found the way
Obsidian finds it, without regard to case: a path as written, or a bare name anywhere in the vault,
the one beside the note first. An embedded note and a wiki-link stay as text. A file counts as a
skipped attachment when it cannot be found, is over 10 MB, sits in a dot folder, or is on a network
share.

Items that have already been imported are detected by `external_source` + `external_id` and shown with a checkmark. Re-importing the same source skips duplicates automatically.

Saved sources persist in `.kangentic/config.json` per project and appear in the Import dropdown for quick re-syncing.
