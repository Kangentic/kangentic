## What's New

- Kangentic now comes in 15 languages. Pick one in the new Language tab, the first of the System tabs in Settings: English, Simplified and Traditional Chinese, Japanese, Korean, German, French, Spanish, Italian, Russian, Brazilian Portuguese, Turkish, Polish, Czech or Hungarian. The two Chinese translations have had a full review pass. The rest are machine translations that are still open to review. On first launch, Kangentic offers your system's language when it ships one. Agent output and terminal text keep their own language.
- An agent CLI installed inside a WSL distro now runs there. Set its CLI path in Settings > Agent to the distro path, such as `\\wsl.localhost\Ubuntu\home\dev\.local\bin\claude`. Every supported agent except Kimi Code can run this way, with its hooks, Kangentic's MCP tools, its history and resume all working from the distro.
- The agent CLI path is now set per project. A path you set before is copied into each project the first time it opens.
- Settings > MCP Server now shows whether agents can reach Kangentic's MCP server, checked from this machine and from any WSL distro a CLI path points into, with a Test connection button. When an agent session cannot reach it, a toast shows the error.
- The task's automations switch is now Pause automations, and it works on a workflow task too. A paused workflow task stays where you put it while you work on it by hand: the workflow does not move it, nudge it or start it until you resume it.
- Plan approval is now set per task instead of for the whole workflow. The control sits above Route in the Workflows inspector and in task detail's Workflow panel while a plan column is still ahead of the task.
- Ctrl+S saves the task edit form. Closing a task with unsaved edits now offers Save, Discard and Keep editing.
- The Changes panel's markdown preview now renders the way GitHub does. Embedded HTML, badges and pictures show, relative links open the linked file, relative images load, GitHub alerts render, and code blocks are colored.
- A paired phone can open a completed task's full report: its route through the board, its linked commits and its per-file changes. Agents can read the same report with the new `kangentic_get_task_report` MCP tool.

## Bug Fixes

- Pausing a workflow now stops every agent in it, and Resume brings every one back. A card moved while its workflow was paused runs its new column's automations when it resumes.
- When an agent moves its own task or pauses its workflow, its session now ends after its turn finishes. A resumed conversation remembers the move instead of making it again.
- A workflow task no longer skips a column when its agent moves it to "next" after the plan approval already moved it on.
- A task now stays in a column that routes on exact final lines when the agent's reply matches none of them, instead of moving on unreviewed.
- A workflow whose agents started in the project root and were resumed in their worktrees no longer stalls. Kangentic now finds a Claude transcript wherever Claude wrote it.
- Reloading the window while a workflow moves tasks no longer starts agents with no prompt in the project root.
- If the window's interface crashes, an agent's terminal no longer stays frozen for about 10 minutes. It resumes within 10 seconds, and the error screen has a Reload button.
- Reloading the window no longer breaks dictation's warm-up or leaves a stray Dictation chip behind.
- GitHub Copilot, Gemini CLI and Qwen Code now honor `COPILOT_HOME`, `GEMINI_CLI_HOME` and `QWEN_HOME`.
