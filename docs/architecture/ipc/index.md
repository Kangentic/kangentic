# IPC channels

## Channel groups

* [Board IPC channels](board-channels.md) - Every project, project group, task, attachment, backlog, backlog import, workflow, swimlane, automation and board-config IPC channel with its pattern and purpose, including the quiet board-reload pushes (task:movedByAutomation, task:prLinkChanged), spawn-blocked events and Asana auth.
* [Session IPC channels](session-channels.md) - The session, usage, Agent Monitor, task-detail ownership, agent, handoff, transcript, search and Knowledge Graph IPC channels: PTY spawn and Command Terminal calls, the pty port a renderer types and reads on, activity pushes, monitor subscribe and peek, detail:syncOwned, transcript paging, the Ask stream.
* [App IPC channels](app-channels.md) - The remaining IPC channels: config, keybindings, mobile bridge, git and diff watching, shell, window, pop-out, Browser pane, clipboard, updater, GPU health, host memory, leftover processes, announcements, diagnostics, dictation and the dev-only preview channels.
