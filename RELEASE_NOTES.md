## What's New

- Run agents on a remote Linux host over SSH. A project can live on the host, and the agent, its worktrees, git, MCP tools and dev servers all run there, with nothing to install on this computer. Add a host in Settings > SSH by config alias, key file, or a one-time password that installs a key. A dropped connection keeps the agent running, and a quit leaves remote agents running for the next launch to take back with their full scrollback. Dev server ports the agent reserves are forwarded to this computer.
- A turn-end automation's Text match can now read your last message in the turn, not only the agent's last line, so a card can move on when you type a sign-off. Kangentic's own typed text never counts as yours.
- A Text match takes one pattern per line, and a pattern that starts with `!` means "not": the row runs when the line matches any plain pattern and none of the `!` patterns.
- A crash in one part of the window, such as a side panel, an overlay or the Command Terminal bar, now stays inside that part instead of taking down the whole window.
- On a board card, the artifact chip fills the room the PR pill leaves on the link row.

## Bug Fixes

- Resume works again for a task whose worktree folder is gone. The task runs in the project folder instead of failing on every Resume.
- On macOS, an update the system refuses because of its signature now tells you once to download Kangentic again, instead of showing a Restart to update button that does nothing.
- Crash reports no longer include task titles or other free text, and handled errors send component names rather than file locations.
