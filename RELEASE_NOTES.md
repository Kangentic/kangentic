## What's New

- The Knowledge Graph is a 3D map of your past task conversations, grouped into named regions. Open it from the brain icon in the title bar or with Mod+Shift+A. Filter it by region, time and outcome, and ask it questions. An answer names the tasks it drew on and narrows the map to them. Its first build shows real progress in one card, and task summaries are now written in every project, not only the open one.
- Model pickers lead with a Latest group (Opus, Fable, Sonnet and Haiku for Claude). Pick one and a column, project default or task follows each new release instead of staying pinned to one version. A column pinned to an older version shows a mark in the Column Manager.
- Moving a task to Done, back to To Do, or deleting it now stops the processes its agent left running in the task's folders, such as a detached dev server. A toast reports what was stopped, and its Review list keeps windows and tmux sessions running and lets you stop the rest one at a time. Turn it off with "Stop leftover processes" in Settings > Behavior.
- The tool-calls popover adds Time and Tokens columns, reports correct durations, and opens where it belongs.
- A newer desktop notification for a task replaces the older one in Windows Action Center or macOS Notification Center, instead of stacking beside it.
- Settings > MCP Server lists its tools in collapsible groups by category. The Diagnostics group starts closed.
- Creating a task worktree is about three times faster on Windows.
- The mobile relay now connects through the system proxy, PAC settings and the OS certificate store, so it works behind a corporate proxy or a TLS-inspecting firewall.
- On Linux desktops such as sway, i3 or WSLg with a keyring running, saved credentials are now encrypted and phone pairing works.

## Bug Fixes

- Kangentic now runs on Electron 44.5.1, which fixes a crash on quit on Windows. macOS 13 is now the minimum. The installer refuses older versions, and Macs on macOS 12 no longer auto-update into a build that cannot open.
- Per-user Windows installs no longer fail to start when the install folder's permissions lack the grant Electron 44.5 checks for.
- A Windows shutdown no longer switches graphics acceleration off on a healthy GPU. It now turns off only after real GPU faults.
- After a terminal closes, clicks no longer throw errors, and the terminal font size can no longer drop below 8.
- A session resumed after a desktop restart comes back at the terminal size it last had, and opening a task on your phone no longer reshapes its terminal on the desktop.
- A malformed kangentic.json no longer breaks applying the board, and one that cannot be read is never overwritten.
- Each Browser pane keeps its own zoom level, and a download of unknown size shows an indeterminate progress bar.
- Browser pane pages are kept out of crash reports, and home folder paths are scrubbed from the reports Kangentic sends.
- The Changes panel shows a widened diff side by side again.
- Agent project defaults in Settings follow the project switcher.
