## What's New

- A plan column can approve the agent's plan for you. Set Plan approval to Automatic on the Column Manager's Agent card, and the task moves on to its After Plan Mode column without waiting. A workflow can set it for its own tasks in the Workflows inspector. Manual stays the default, and questions and every other permission prompt still wait for you. Automatic approval works with Claude Code, and the Conversation view shows the approved plan as a Plan card. Gemini CLI, Qwen Code and Copilot now report their plan exits too, so After Plan Mode moves their tasks on.
- Right-click a card and choose Disable automations to hold every column automation for that one task, on enter, turn end and exit, without changing the column. The card shows an Automations disabled strip and the run log records each skipped row. The switch clears when the task leaves Done, is restored from the archive or joins a workflow. Agents can set it through MCP.
- The task card's right-click menu has Pause session and Resume session, on the board, in the Agent Monitor and on the Workflows canvas. The menu's bottom group now holds only Backlog, Archive and Delete, and Changes is now Show changes.
- A paired phone can drop a notification once it is dealt with at the desk: the prompt was answered, the task moved, or the session ended. The phone needs a Kangentic Mobile version that supports it.

## Bug Fixes

- On agent turn end automations run more reliably. A tool call from one of Claude Code's internal agents after the turn ended, or a subagent re-tasked after its first run, no longer stops a column's rows from running. A Qwen Code turn no longer counts as ended while a background subagent is still working. A card dragged to its After Plan Mode column after the plan was approved no longer skips that column's rows. A row that does not run now says why in the run log, and Run again on a Move to column row moves the task.
- The Agent Monitor's Backlog item deleted the task. It now sends the task to the backlog, and Backlog and Delete ask first as they do on the board. A move, archive or delete made from the Agent Monitor now shows on the board right away, and pausing another project's task from it works.
- The Changes diff no longer throws "Illegal value for lineNumber" when a file gets shorter while you are scrolled down. A refresh of the open file keeps your place.
- On macOS and Linux, agent hooks and status lines now work in a project whose path contains a dollar sign or a backtick.
- Opening a workflow that another session saved no longer starts a planning agent that ignores the saved plan. The pane opens folded, and Ask for changes starts the agent with the saved plan.
- Move to and Pause or Resume session on the Workflows canvas now update that task's board, which could show the card in its old column.
- The sidebar's project rows no longer open a tooltip that covered the rows above. The counts sit on the row and the path is in Settings > General.
- With Animations off or reduced motion on, the usage dashboard's charts no longer animate.
