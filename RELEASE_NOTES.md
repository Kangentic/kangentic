## What's New

- Kangentic can pause agents that are waiting on you, to free the memory they hold. Settings > Performance > Pausing agents has two switches. When memory runs low (on by default) pauses the agent that has waited longest, one a minute, until there is room again. It reads Windows commit, Linux free memory and swap, or macOS memory pressure. When idle (off by default) pauses any agent that has waited for the minutes you set. An agent that is working, has text in its prompt, or has its terminal on screen is never paused. A paused agent stays paused until you resume it, across a restart too. One toast counts the memory pauses, and its Review list resumes them one at a time.
- The Windows low memory warning now names the two changes that help, a larger page file and fewer agents at once, and shows how old its reading is. The user guide has a new Low memory warning section with the measured cost of each agent.
- Every toast has a title over one line of detail. A toast that closes on its own draws a line along its bottom edge as its time runs out, and hovering it holds the time. A toast about one thing opens it when clicked. While a dialog or Settings is open, toasts take no clicks, so one sitting over a dialog's buttons no longer swallows them.
- The conversation viewer reaches a large conversation's whole history. A transcript past 16 MB loads its earlier part as you scroll up, the scrollbar spans the whole conversation, and Jump to start goes to the first message.
- A task that worked in two or more columns gets a tab per column in the conversation viewer, next to All. Clicking a column in a completed task's Route opens the viewer on that tab, and an archived card's right-click menu has View conversation. Every table on the completed task's Usage tab sorts by its headers.
- A column that runs an isolated session is marked with a split icon wherever the app names it: the Column Manager, the Session control, the task window header, the conversation tabs and the Usage tab.
- Dragging a card into another column parts that column's cards at the slot it will take, and a dimmed copy holds the slot until you drop.
- The Workflows view tab shows how many unfinished workflows the project has, and the Backlog tab's count has the same pill.
- Agent Monitor cards are now the board card, with a strip naming the project, the workflow and its step track. A task with automations off shows the board's Automations disabled strip, and the table gains Workflow and Automations columns.
- Gemini CLI, Qwen Code, Copilot, Codex, Kimi and Grok now report the background commands they start, so a task stays working until its command exits. An agent can mark a dev server or watcher as a service so it stops holding the task, and the column's On agent turn end automations run. On agent turn end automations now run for Codex and Kimi.

## Bug Fixes

- On Windows and Linux, Kangentic ends Claude Code by closing its console instead of typing Ctrl+C and /exit. The typed exit could resend a thinking turn's prompt as a second paid turn, or approve a permission prompt that was open.
- A Planning column set to approve plans automatically no longer stops at "Do you want to proceed?" for an MCP tool your allow rules already permit.
- A task with Disable automations on no longer has its plan approved automatically.
- A change to `.claude/settings.json`, or the Gemini or Qwen equivalent, now reaches the next session without restarting Kangentic. A new session could stop at a permission prompt for a rule the project had already added.
- Activity marks no longer freeze when the operating system reports reduced motion. Settings > Performance > Animations is the one switch that turns motion off.
- The context bar's 7-day usage bar now drops after a free usage reset instead of staying at 99 or 100%.
- On Windows, hooks and status lines for Copilot, Gemini CLI, Qwen Code and Grok are quoted for the shell each CLI runs them in, and Qwen Code's hooks run.
- On Windows, a project settings save no longer fails while a file-sync client holds the settings file, and stopping a task's processes can no longer end an unrelated process that reused a process ID.
- A Command Terminal no longer shows the typed agent command above the agent's banner. A Command Terminal whose shell cannot start shows one error and closes instead of loading forever.
- Reopening the conversation viewer on a very large transcript no longer stops the background search index.
- Deleting a task or a project while its worktree is still being set up no longer leaves the worktree and branch behind.
- Idle cards on the Workflows canvas no longer draw a large pulsing halo.
- A paired phone that is away no longer flashes Reconnecting in Settings > Mobile Devices every minute.
- When the background index restarts, the usage dashboard says so instead of listing every project as unreadable.
