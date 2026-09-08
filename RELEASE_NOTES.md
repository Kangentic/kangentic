## What's New

- **Azure DevOps pull requests.** A task on an Azure DevOps remote now resolves and shows its PR the way a GitHub task does, including a pasted `/pullrequest/<id>` URL. PR lookups are dispatched only to the connector that owns the remote, so a remote Kangentic cannot read reports a clean miss instead of clearing the task's existing PR link.
- **The Branch row says where the task will run.** The worktree on/off toggle is now a Worktree / Project pair, so the project folder is a named choice rather than an unnamed off state. When a worktree is impossible (not a git repository, a repository with no commits, or a project folder that is itself a worktree) that option is disabled with the reason as its tooltip, and the hint below states plainly where the agent will run. The task detail menu now names the folder it opens.
- **A `{{projectPath}}` template variable.** Auto-command and spawn-agent prompt templates can now reference the main project checkout, which `{{worktreePath}}` could not express for a task with no worktree. It lets a column hand an agent something like `git -C {{projectPath}} merge {{branchName}}`.

## Bug Fixes

- Agent detection walks every match on PATH instead of stopping at the first. A dead npm shim left behind by an uninstalled package no longer shadows a real install and reports the agent as not found.
- On Windows, a multi-line prompt now reaches an npm-installed agent whole. The `.cmd` shim runs through cmd.exe, whose command line ends at the first newline, so the task XML arrived as `<task>` alone. Kangentic now launches the sibling shim npm writes beside it, and falls back to a flattened one-line prompt when there is no usable sibling. Codex prompts are covered by the same path.
- A dev server an agent left running no longer blocks worktree removal. Moving a task to Done, To Do, or Backlog, or deleting it, reaps the session's leftover processes first; removal is bounded by a 30 second clock instead of an unbounded retry ladder; and a removal that still fails names the process holding the folder.
- Kangentic degrades instead of half-starting when the global database cannot be read. An antivirus or cloud-sync lock on `index.db` used to leave a permanent spinner and a raw IPC error. You now get a dialog naming the file, the SQLite code, and the likely causes, with Retry and Quit.
- A swimlane role outside the known set no longer blanks the whole board. A legacy or teammate-authored role is normalized when it is read from the database, when it arrives from `kangentic.json`, and by a migration that repairs what is already on disk.
- Reopening a task whose agent is running goes straight to the live terminal instead of showing the "Resume session" overlay while the board card shows it running.
- Claude Code's fullscreen diff panel no longer opens itself on spawn. It duplicated the task window's own Changes tab and shared rows with the transcript, which confused activity detection. Typing `/diff` inside a session still opens it.
- Expanding a terminal panel or clicking a terminal tab moves focus reliably on a loaded machine. The focus claim used to lapse before the terminal finished mounting, and the click silently did nothing.
- On macOS, a launch-time activate event no longer races startup into a second, orphaned window, which left Kangentic unable to kill PTYs and save session state on quit.
- Kangentic no longer crashes on quit while terminal exit callbacks are still arriving.
- A restored diff scroll position is clamped to the current layout instead of landing past the end.
- The Agent Monitor detail no longer fails on a project config that has no agent section.
- Fewer un-actionable errors are reported. Transient update-feed failures and conditions the app already handles are no longer sent to error reporting.
