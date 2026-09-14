## What's New

- **Columns have automations.** A column owns an ordered list of things it does when a task enters or leaves it: send a message to the agent, run a script, call a webhook, or raise a desktop notification. Each row has its own switch, and its own record of what happened the last time it ran. Click a column header to open the Column Manager and build the list.
- **A column's message to its agent is one of those automations now.** Your existing messages were moved into one automatically, so nothing stops happening and nothing needs re-typing; the field is simply gone from the column's settings card, and the message appears as a row in the list beside anything else you add.
- **Template variables paint as you type.** Every automation's text fields recognise `{{title}}`, `{{fromColumn}}`, `{{toColumn}}` and the rest, highlighting the ones that will resolve and flagging the ones that will not. Type `{{` to pick from the list. A script also receives every variable as a `KANGENTIC_*` environment variable, which is the quoting-safe way to read one.
- **An automation that fails says so.** One toast names the automation and the column, with a Run again action; the run log keeps the detail either way. Nothing is retried on its own, because a fired webhook and a half-run script are not safe to repeat blind.
- **Three column actions that never did anything are gone**, along with the rows that carried them: Kill Session, Create Worktree and Remove Worktree each duplicated something the move already does. If your board still has a Start Agent action carrying a custom prompt, it survives as a legacy row you can edit or delete.
- **Merge readiness on the pull request pill.** A linked PR now shows whether it is actually ready to merge, not just whether it has conflicts. GitHub counts a merge bypass you personally hold, so a PR waiting on a review you could bypass reads `ready` rather than blocked, and stays that way once somebody else's PR lands and leaves yours behind the base. Azure DevOps folds its branch policies into the same verdict. Checks that are still running now read `queued` or `running` instead of a flat `blocked`, so the pill tracks CI while it runs.
- **Model lists come from the agent CLI.** Kangentic asks each agent CLI which models it supports instead of shipping a curated list that goes stale between releases.
- **Remotes fetch in the background, and "behind" is measured against the base branch.** The branch pill stays current without you running a fetch yourself, and the ahead/behind counts compare against the branch the work actually branched from. The refresh interval is configurable, or can be turned off.
- **Moving a task from your phone answers as soon as the move commits**, rather than waiting for the whole board to settle.

## Breaking Changes

- **The first save after upgrading rewrites `kangentic.json`.** Automations now live under the column that owns them, so the top-level `actions` and `transitions` arrays and each column's `autoCommand` / `autoCommandMode` are dropped from the file. All four are still read, so an existing file opens and converts on its own; none of them is written again. Expect a real diff in a tracked file the first time you save a board.
- A teammate on an older build who pulls that file loses its transitions. On a default board that costs nothing, because every seeded transition was a no-op or a duplicate of the spawn that happens anyway. A customized board loses its custom rows until that teammate updates.

## Bug Fixes

- An agent being stopped now gets its exit sequence and a short grace period before any force-kill, so a session that just started is never killed mid-write.
- The terminal keeps retrying WebGL after a GPU crash instead of staying stuck on the slower canvas fallback.
- A task no longer stays marked as waiting on you after you deny a permission prompt.
- Respawning an agent in the same column shows a launch overlay instead of a misleading Resume or Paused control.
- Switching between board views no longer cross-fades cards into the wrong places.
- The Done column now appears in the MCP board read tools.
- A task with no worktree can link its pull request, because the branch is captured when it is pushed.
- Kangentic refuses to infer a pull request or branch that another task already holds, instead of two tasks claiming the same one.
- Azure DevOps titles containing HTML entities, including emoji written as numeric entities, decode to the right characters.
- Shell arguments are escaped by the rules of the shell that will actually parse them, rather than one uniform chain applied everywhere.
- Removing a task clears the sessions it left behind, and moving a task back out of To Do re-arms the agent override lock.
- Phones receive one handshake per arrival instead of a burst, and a push notification that fails to deliver is surfaced rather than silently dropped.
- Linux update checks compare against the newest older release, so an upgrade is no longer offered as a downgrade.
