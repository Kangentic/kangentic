## What's New

- Priority draws as four equal bars after the ticket number on every card, so it sits level with the title at any level. The same meter appears in the Backlog, the task window, the Priorities button and the Priority field in New Task and Edit Task, which is now a list that shows each level's meter.
- When an agent ends its reply on a `Needs owner:` line, the column's Send message automations hold instead of nudging it past its question, and the card stops for you.
- A plan column left at Manual approval now says so when an agent sets up or starts a workflow, naming the tasks whose plans will wait for you.
- The phone app can show who paused a task and follows the card Priority and Labels switches.

## Bug Fixes

- Push-to-talk works in popped-out windows: a Browser pane, the Command Terminal, the Agent Monitor and the Knowledge Graph.
- Mouse back and forward buttons navigate the Browser pane in every window, including with dictation turned off.
- Ctrl+click on a terminal link opens it in the task's popped-out Browser pane, even while that window is still loading.
- Turning on Draw or Select element in the Browser pane no longer closes a menu open on the page, and their shortcuts work right after a click in the page.
- If Kangentic restarts after you sign off but before the agent replies, the next turn end still reads your sign-off.
- After a restart resumes several tasks mid-step, each workflow nudge goes out a minute after the last instead of up to three.
- The Command Terminal panel reopens over its terminals after a restart, which it sometimes skipped.
- A task in an SSH project opened right after launch waits for the host to connect instead of failing.
- A Done card lines up with board cards and shows more of its title. Delete moves to its right-click menu.
- Electron 45.4.1, with its security fixes.
