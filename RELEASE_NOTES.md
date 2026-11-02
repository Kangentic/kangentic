## What's New

- Command Terminals now survive a restart. A terminal left running at a quit, a crash or an OS kill comes back in the same slot with its name, conversation, model and effort. Stop is the only thing that ends one for good. It follows the setting that resumes task agents after a restart.
- Earlier is now a full archive of your Command Terminal conversations. Rename or remove a row from its right-click menu, scroll the whole history, and search names, first prompts and conversation text.
- Rename a Command Terminal from the pencil after its title. The panel's rail is resizable and folds to a strip of activity marks, and dragging it changes the panel's width instead of refitting your terminals. Double-click a seam to even its two terminals.
- A column can now run one agent at a time. Turn on the switch in the Column Manager and other tasks wait in the order they entered, with their place shown on the card.
- New tasks start faster in projects with a Post-worktree script. A Claude agent starts while the script runs and gets its prompt once the script succeeds, and the project keeps one spare worktree with the script already run for the next task. Moving a task to Done sets its worktree aside and deletes it in the background.
- A project can set a Stop script in Settings > Git. It stops what a task left running after an idle or low-memory pause and before Kangentic clears the task's leftover processes. It saves to `kangentic.json`, so the team shares it.
- Cards, the Workflows views, Agent Monitor, toasts and notifications now say what an agent is waiting for: a question, an approval or a finished turn. A paired phone shows the same.
- A message sent to a task with no running agent is now held and goes out with the next agent that starts or resumes there. This covers MCP messages, Move to column messages and chat from a paired phone.
- Long workflows recover better. Each nudge is aimed at what the agent is stuck on, only a final "Needs owner" line stops a task, a task paused for low memory resumes once memory recovers, and automated keys are never typed into an open permission prompt.
- New hotkeys walk your running agents and then your Command Terminals (Ctrl+Tab, or Ctrl+Shift+Tab across all projects), and your projects in sidebar order (Ctrl+Backquote and Ctrl+Shift+Backquote). You can rebind them in the Hotkeys tab.
- Ctrl+S now saves in every dialog with an editable form.
- Notify me automations now reach every paired phone, with the row's own title and body.
- Deleting a started workflow can also delete its tasks that never started. The confirm offers this, off by default.
- Cursor CLI sessions now show their context use and live model, trust the folder on non-interactive and resume starts, keep the PTY session with Skip Approvals, and show their transcripts in the session view.
- An agent can no longer delete another task, or send one back to To Do, while that task holds running work or unmerged commits. Your own deletes and drags are unchanged.

## Bug Fixes

- A resume prompt is no longer lost for Codex, Copilot, Grok, OpenCode and Cursor.
- Handoff records save again.
- OpenCode's activity plugin now installs under a name OpenCode loads, so its activity shows on the board.
- Background sessions started with `/bg` now stop when their task or Command Terminal ends, and before a resume.
- A headless Claude call refused for a bad key now retries on your stored login.
- Adding a project now refuses a folder Kangentic cannot write to.
- The automation failure toast names the task, opens it, and runs Run again in the failure's own project, even after you switch projects.
- The rate limits pill shows each window the agent reports and drops lapsed ones.
- Leftover process cleanup now recognizes a task's own stack, reaches a .NET Aspire AppHost, and retries the macOS window list.
- A task now shows earlier conversations only when there is real prior work.
- Settings tabs and labeled controls no longer show tooltips that repeat their label.
