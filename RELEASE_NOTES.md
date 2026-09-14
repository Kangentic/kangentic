## What's New

- **Merge readiness on the pull request pill.** A linked PR now shows whether it is actually ready to merge, not just whether it has conflicts. GitHub counts a merge bypass you personally hold, so a PR waiting on a review you could bypass reads `ready` rather than blocked, and stays that way once somebody else's PR lands and leaves yours behind the base. Azure DevOps folds its branch policies into the same verdict. Checks that are still running now read `queued` or `running` instead of a flat `blocked`, so the pill tracks CI while it runs.
- **Model lists come from the agent CLI.** Kangentic asks each agent CLI which models it supports instead of shipping a curated list that goes stale between releases.
- **Remotes fetch in the background, and "behind" is measured against the base branch.** The branch pill stays current without you running a fetch yourself, and the ahead/behind counts compare against the branch the work actually branched from. The refresh interval is configurable, or can be turned off.
- **Moving a task from your phone answers as soon as the move commits**, rather than waiting for the whole board to settle.

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
