## What's New

- A card the board has stopped now shows a pennant in place of the envelope, so you can tell a card waiting on you from any other idle card. A review that reaches a step only a person can do now stops there, instead of going back to Executing and back again.
- A workflow card that has stopped is yours to move. In motion it stays locked, but once stopped it moves to any column except To Do, and the route carries on from where it lands.
- An agent that decides nothing needs changing can end on `No changes needed: <why>` in any column, and the card goes straight to Done. Kangentic checks the branch first, so a branch with commits or uncommitted changes moves nothing.
- A workflow task can no longer pause its automations. To stop work, pause the workflow. Any holds already set are cleared on update, and those tasks switch to Manual plan approval, so a plan a person meant to review still waits for them.
- The queued task window is finished. It says where the task is in line and why it is waiting, links to the setting that controls that, and shows the agent, model and effort it will start with.
- Changing the model or effort of a queued task now keeps its place and its prompt. Before, the change could start the agent with no prompt at the back of the line.
- A launch that never starts is retried once on its own. If the retry also fails, the "Agent didn't start" notice shows the raw error with a Copy button, or the CLI's own line for a login failure.

## Bug Fixes

- Kangentic now checks that a project's database owns its folder before cleaning anything up. A second instance started from a copied database could delete real worktrees, session folders and task attachments. Orphaned worktrees and task folders now move to `.kangentic/set-aside/` for 14 days instead of being deleted.
- A task whose worktree folder is gone keeps its card and branch, and Resume recreates the folder. Agents no longer start in the home directory when their folder is missing, and the card says "Worktree missing", "Folder missing" or "Didn't start" in place of "Paused".
- Removed the "Low on memory" warning, the memory-triggered agent pause and the "When memory runs low" setting. A short spike could fire them on a machine with plenty of free memory, and no reading was reliable enough to stop an agent. The When idle timer still pauses idle agents. A saved config that still has the old setting loads unchanged.
- Claude's model pickers show the Latest group again on macOS and for users with no Claude history.
- Bedrock and Vertex model ids now show a clean name, such as "Opus 4.6", instead of the raw provider prefix.
- A workflow no longer moves a task out of a column only a person can clear. On one PR state, tasks could move on and merge with no approval.
- A Move to column row that names a column the task's route skips now goes to the route's next column, so a task no longer bounces back and forth.
- A workflow's task no longer raises the "Agent finished" toast, and an empty reply counts as a stall in every column.
- Listing worktrees no longer stalls the app on Windows, because git now runs outside the main process.
- Quitting waits for the terminal host to finish, which fixes a crash on exit.
- A .deb install with no dpkg or apt now says so once, instead of "Restart to update" doing nothing.
- If Kangentic cannot create its data folder, the startup dialog shows the folder, the raw error and the cause, instead of blaming a program holding a file.
