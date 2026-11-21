## What's New

- Automation conditions are a list of lines, and every line must hold. New Priority and Labels lines limit a row to the tasks it is meant for, and a row can hold a Text match and an Evaluation together.
- Import Tasks reads a new Repository folder source: each folder under a path in the repository becomes a task, so a folder workflow such as OpenSpec runs on the board. Each saved source can put a label on every task it imports, and its row menu has Edit source and Remove.
- To Do and Done can run On task enter automations for Notify and Webhook, so "tell me when it's done" and "close the issue in the tracker" work there.
- The Edit automation dialog reads Trigger, Condition, Action, Frequency, and opening one section slides the other shut.
- Priority draws as a level meter, one bar per level, on board cards, the task window and the Backlog list. On a card it sits in the title row.
- Settings > Task > Cards has switches to hide priority and labels on board cards, the Done list, workflow cards and Agent Monitor cards.
- The Backlog list keeps each row's labels on one line, with a +N chip for the rest, and every row is the same height. Each row has a menu button, and an Updated column replaces Created.
- Bottom panel tabs show the same activity mark as the task's board card, with its reason in the tooltip.
- Moving an idle-paused task into a column that starts an agent starts the agent again. A pause you made yourself still holds.
- Board config changes from kangentic.json apply at once by default. Turn off Auto-apply changes in Settings > Board to get the confirm dialog back.
- An agent's browser pane shows what the agent is doing, and an agent's own browsing stays behind the terminal until you open it.
- A task's artifact keeps its name when the same link is added again, and one Claude artifact shows as one row however many of its links were added.

## Bug Fixes

- Claude accounts share agents, commands, rules, output styles, themes and workflows made from any account. The first session on a second account creates those folders in ~/.claude when they are missing, and a change a refresh would overwrite is reported.
- The Changes panel lists the files of a project that has no commits yet. It failed to load there before.
- Editing a task no longer reloads the page in its Browser pane, and Edit reaches a task window that is already open.
- A column's Send message automation reaches an agent the move starts fresh in its opening message, so its first turn has it, and a waiting message from a recap carries over to a replacement session.
- A move made from a Command Terminal starts a run-once automation's count over, like a drag.
- A Text match on the user's prompt checks every message in the turn, not only the last.
- An account that has spent its weekly allowance stays marked spent until the allowance resets.
- Azure DevOps imports no longer fail on a large project or a stored time.
- On Windows, an agent installed as a `.cmd` shim with a PowerShell script behind it starts.
- An SSH project's context bar names the host's shell.
- A Cursor session shows slash commands that run a skill.
- An agent's screenshot is copied into its own folder, so it never asks for permission to read it.
