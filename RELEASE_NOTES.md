## What's New

- **Columns have automations.** A column owns an ordered list of things it does when a task enters or leaves it: send a message to the agent, run a script, call a webhook, or raise a desktop notification. Each row has its own switch, and its own record of what happened the last time it ran. Click a column header to open the Column Manager and build the list.
- **A column's message to its agent is one of those automations now.** Your existing messages were moved into one automatically, so nothing stops happening and nothing needs re-typing; the field is simply gone from the column's settings card, and the message appears as a row in the list beside anything else you add.
- **Template variables paint as you type.** Every automation's text fields recognise `{{title}}`, `{{fromColumn}}`, `{{toColumn}}` and the rest, highlighting the ones that will resolve and flagging the ones that will not. Type `{{` to pick from the list. A script also receives every variable as a `KANGENTIC_*` environment variable, which is the quoting-safe way to read one.
- **An automation that fails says so.** One toast names the automation and the column, with a Run again action; the run log keeps the detail either way. Nothing is retried on its own, because a fired webhook and a half-run script are not safe to repeat blind.
- **Three column actions that never did anything are gone**, along with the rows that carried them: Kill Session, Create Worktree and Remove Worktree each duplicated something the move already does. If your board still has a Start Agent action carrying a custom prompt, it survives as a legacy row you can edit or delete.
- **The Column Manager is easier to use.** Remove column is a labeled button in the dialog footer instead of a small glyph on the rail, the automation hint on the rail is a single lightning glyph shown only when something would actually run, and the default height fits every settings row on a tall display without a scrollbar.
- **The agent's latest message on task cards.** A card's description slot now prints what the agent last said, pushed live as it changes, in the same well the terminal peek uses. Settings > Task > Card Preview picks Latest agent message (the default), Recent agent messages, or Task description. The Agent Monitor card follows the same setting, and the two cards now share one design.
- **Goose CLI.** Block's Goose is a selectable agent. Resume maps to Goose's own session names and the permission mode maps to its `GOOSE_MODE`.
- **Pick a theme by eye.** The Theme tab is a grid of twelve swatches, each painted from its own palette. Hovering a tile previews it on the whole app without committing, arrow keys re-theme live, and a Follow system appearance switch keeps one theme for a light OS and another for a dark one. Two new themes, Rust and Clay, are built from the Kangentic site's tokens; Dark and Light are now named Graphite and Paper.
- **Move a task one column without closing its window.** Alt+Shift+Left / Right steps the open task while its terminal stays open. Column automations still fire and the existing move confirmations still gate it.
- **Images reach the agent as attachments.** A pasted or dropped image arrives as a bracketed paste, so Claude Code attaches it directly instead of spending a tool call to read the path. A format the agent cannot take from a path, such as bmp, is re-encoded as PNG first.
- **Start a session from your phone.** The mobile app can start a task's session again after the agent exited on its own or you paused it on the desktop. A desktop that predates a newer verb now answers with a refusal instead of leaving the phone to time out.
- **The Import dialog opens instantly.** It paints a per-project cache of the source's items and syncs only what changed since the last fetch in the background. The Open / Closed / All toggle filters the cache without another request.
- **Subagent spend in the usage dashboard.** The Subagents tile reports nesting depth, and the data groups fan-outs by the turn that started each one, so a task that spawns the same subagent from several turns reads as several fan-outs.
- **MCP column tools carry the session fields.** `kangentic_create_column` and `kangentic_update_column` accept `sessionTarget`, `sessionSpawnStrategy` and `autoCommandMode`, and validate every enum in the handler, so an agent-built Code Review column runs isolated the way a hand-built one does.
- **The web demo.** The desktop renderer now builds for a plain browser with real recorded sessions, which is what the site and the docs embed. It has no effect on the installed app.

## Breaking Changes

- **The first save after upgrading rewrites `kangentic.json`.** Automations now live under the column that owns them, so the top-level `actions` and `transitions` arrays and each column's `autoCommand` / `autoCommandMode` are dropped from the file. All four are still read, so an existing file opens and converts on its own; none of them is written again. Expect a real diff in a tracked file the first time you save a board.
- A teammate on an older build who pulls that file loses its transitions. On a default board that costs nothing, because every seeded transition was a no-op or a duplicate of the spawn that happens anyway. A customized board loses its custom rows until that teammate updates.

## Bug Fixes

- A renderer out-of-memory recovers into a fresh window instead of leaving a dead one.
- Dictation runs its engine in a separate worker process, so an engine crash cannot take the app down, and offline decodes no longer overlap each other.
- A GPU crash writes a next-boot report, and routine GPU exits no longer fill the log.
- A card lifts on Space or Enter only after Tab placed the focus, so a mouse-focused card never lifts and no ghost card outlives a click into a terminal.
- The board's toolbar rows collapse at a narrow window instead of clipping.
- Card drags stay smooth: terminal construction waits until the drag ends.
- A Start from the phone never displaces a Resume already in flight, and a second Start racing the first cannot type the column message twice.
- A delivered slash command is confirmed in place rather than restarting the session, and a verifier error at the final check counts as a miss rather than an abandon.
- Dropdown menus place correctly on first open, and Escape closes only the top layer.
- The phone reconnects when the relay reaped a socket that still read as connected.
- A renamed or moved project reports as stale in the sidebar instead of failing silently.
- Settings writes survive an unwritable data directory.
- The Light theme's diff pane renders light, and a coloured label pill paints from its own colour.
- Clickable controls ignore text selection while copyable text stays selectable.
- Removing a session is announced on its own channel, so no phantom row is left behind.
- An import that partially fails reports what it could not do instead of succeeding quietly, and an empty id list can no longer wipe the import cache.
- A legacy board no longer loses its migrated transition scripts, and a dragged automation row stays inside its own group.
- The activity indicator reports a reason that changes mid-turn, and a reason-only refresh no longer steals focus.
- A message that straddles two transcript reads is counted once in the usage ledger.
- The onboarding mascot intro completes its handoff reliably.
- `kangentic_tail_logs` also reads the log written while no project is open, merged by timestamp with the project's own, so a trace from the Welcome Screen is no longer on disk but unreachable.
