## What's New

- Settings > Accounts keeps several logins per agent. A new session starts on the first account with room, a session that hits its usage limit carries on with the next account, and every conversation stays in the agent's own history whichever account wrote it. Order is Automatic (soonest reset first) or Manual, and Switch to moves an account to the top. Claude Code supports multiple accounts, and so do Aider, Cursor, Droid and Warp with key files.
- Tasks keep a list of artifacts: links to designs, documents and diagrams. Add them in the edit form, or let Kangentic pick them up from what an agent publishes or prints. They show on the card and in the task header, and agents can read them through the `{{artifacts}}` template keyword.
- A new "Click opens links in" setting picks the browser a link click opens, and Ctrl or Cmd click opens the other one. It covers PR pills, artifacts and terminal links, and replaces the two terminal link hotkeys.
- A column can collapse to a narrow strip that still takes a drop. Column width gains Fill, which shares the row between columns. Shrink empty columns, off by default in Settings > Board, narrows an empty column to the width of the widest header.
- Resuming a Claude Code session in the column it was paused in keeps the permission mode the session was last in, so a session you switched out of plan mode stays out of it.
- The Changes panel's Checks section is now Pull request. It opens by itself when the PR has something to fix, its header shows the same count as the Changes button, and its button opens the PR.
- The Edit Task form keeps the Branch field past To Do, with Pull request beside it.

## Bug Fixes

- A board launch whose shell is slow to start, such as a PowerShell profile that takes more than 30 seconds, is no longer paused and retried while its command is still waiting. A launch that prints a clear failure is still caught within about 30 seconds.
- The Command Terminal panel reopens after a restart even when bringing its terminals back takes longer than usual.
- Error reports from a failed launch, a missed resume, or a full disk now carry enough detail to tell what went wrong.
