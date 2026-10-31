---
type: Reference
title: Transient sessions
description: "How Command Terminals and workflow agents run as transient sessions with no DB row: startCommandTerminal's slot claim and four-terminal cap, cold-spawn checkout, spawn-failed handling, resuming an earlier conversation, the kill flow, and rebuilding slots after a renderer reload."
tags: [sessions, transient, command-terminal, slots]
sources:
  - resource: src/main/ipc/handlers/transient-sessions.ts
  - resource: src/renderer/stores/session-store/transient-recovery.ts
  - resource: src/shared/command-terminal-name.ts
---
# Transient sessions

Command Terminals are ephemeral agent terminals spawned from the command bar (Ctrl+Shift+P) or by a paired phone's `command-terminal` start. They are transient sessions, and they differ from task-bound sessions in several ways:

- **No task association** - run at the project root with no Kanban task
- **No DB persistence** - no session record in the database
- **No resume in place** - killed on close, and a suspend ends the terminal, since no task record keeps its place. What survives is the conversation: `CommandTerminalHistory` records each one the terminal held (`command_terminal_history`), and a later start can resume it by id (see [Resume](#resume))
- **Queued like any spawn** - at the concurrency limit the row starts `queued` and already holds its slot

A workflow's own agent is the other transient session. It shares the first two and the queue, but
not the third: its Pause is a suspend that keeps its row, and Resume brings back its conversation.
Everything in this section that is a Command Terminal's alone (the slot, the cap, the end) is
decided by `isCommandTerminalSession`, never by `transient`. See
[Workflow agent](../workflows/workflow-agent.md) for the workflow agent.

## Identity survives a renderer reload

Which Command Terminal window owns which PTY is a `(projectId, slot)` pairing held in the
renderer's `transientSessions` map. That map is renderer-only memory: HMR preserves it via
`import.meta.hot.data`, a full page reload does not. Main keeps every transient PTY running
regardless, so without recovery a reload left a live conversation with nothing pointing at it,
and the window came back as an empty fresh boot.

Main is the authority for the pairing. `ManagedSession` retains `commandTerminalSlot`,
`commandTerminalBranch`, `commandTerminalLabel` and `commandTerminalNamedByUser` (in memory, not a
DB row, so this does not make a transient session persistent), and `toSession` carries them to the
renderer on every session row. The flag marks a label the user set or cleared by hand
(`session:renameTransient`), which the namer and the resume seed then leave alone. `planTransientRecovery`
(`src/renderer/stores/session-store/transient-recovery.ts`) rebuilds the map from that on every
`syncSessions`, for every project:

1. An entry already pointing at a running session is kept verbatim, which preserves the branch
   the HEAD tracker corrected. The name needs no recovery: main holds it on the session row.
2. Every other survivor claims the slot main recorded for it.
3. A survivor whose slot is taken, or that carries none, takes the lowest free slot, so no live
   PTY is left unreachable.

Step 3 is the one case where a terminal is renumbered; see
`src/shared/command-terminal-name.ts` for why that is preferred to orphaning it. A window that
mounts before recovery runs adopts an unpaired live PTY for its slot rather than spawning
(`findAdoptableTransientSession`), so the duplicate cannot be recreated by a race.

## Spawn Flow (`startCommandTerminal`)

`SESSION_SPAWN_TRANSIENT` and the phone's `command-terminal` start both run `startCommandTerminal`
(`src/main/ipc/handlers/transient-sessions.ts`). It first claims a slot: the window's requested
one (`slot-1` to `slot-4`) when it is free, else the lowest free one. The project's non-exited
Command Terminal rows (a workflow agent's never) and every in-flight start's reservation count as
occupied, and a start past
`MAX_COMMAND_TERMINALS` is refused (`command-terminal-limit`). The reservation is taken before the
first await and released once the spawn has registered its row or the start has failed.

1. Resolve the target branch: the picker's choice, else the project default base
   (`resolveProjectDefaultBaseBranch`: board default for the path, then `git.defaultBaseBranch`,
   then `main`), after a throttled `fetchIfStale` of that branch. When the tree is on another
   branch, no branch was picked, and there are uncommitted TRACKED changes, it stays put and the
   response carries a `checkoutError` the renderer toasts ("Staying on ..."); nothing else runs.
   Otherwise the handler checks out the target if needed, then fast-forwards it onto
   `origin/<target>` (`--ff-only`, failure ignored) whenever the fetch produced a remote start
   point. A checkout failure falls back to the current branch with a `checkoutError`, and git's
   own reason goes to the log rather than the toast. This runs
   on a cold spawn only; a reattach never fetches or checks out
2. Create a session directory at `.kangentic/sessions/<transientTaskId>/` for bridge files
3. `await adapter.ensureTrust(projectRoot)` - trust pre-population, `kangentic` MCP enablement,
   and for Claude the diff-panel write (see
   [Global Config Writes](../../integrations/agents/claude-code.md#global-config-writes-claudejson)). The Command
   Terminal bypasses the two spawn chokepoints, but not this: every path that builds an agent
   command applies the adapter's pre-spawn global-config state first
4. Build the agent command (with MCP server if enabled), passing `capturePromptText` so the
   prompt hook reports the first prompt's text for `CommandTerminalNamer`, and the terminal's own
   made-up task id as `taskProcessTag`
5. Call `SessionManager.spawn()` with `transient: true` and the claimed slot
6. If `spawn()` returns an exited row (the shell did not start, so node-pty refused it and its exit
   was already announced), end that row through `SessionManager.endCommandTerminal` and fail the
   start with `CommandTerminalStartError` code `spawn-failed`. The message names the shell and
   points at Settings > Terminal. The desktop window toasts it and closes, and a phone's start gets
   `command-terminal-start-failed`. A shell that failed to start is never returned as a success

An unattended (phone) start runs the same steps with a non-interactive 5 s fetch, one 6 s git
budget, and no checkout while another running or queued session's cwd is the project root.

The start reads everything from the project its input names, never from the main window's
current project, so it needs no project open on the desktop: a phone and the detached Command
Terminal window both rely on that.

### Resume

A start with `resumeAgentSessionId` resumes an earlier conversation instead of a fresh one. It
reads the conversation's row from the project's history (`resolveResumedConversation`), refusing
with `conversation-gone` when the row is missing or its agent cannot resume by id
(`canResumeConversationById`). It then claims the conversation (`claimResume`), refusing with
`conversation-open` while a live terminal or another resume holds it, so two agents never write
one transcript. The command is built with the conversation's id and `resume`, the spawn is marked
`resuming` and touched (`hasUserInput`), and the terminal's label is seeded from the row so the
namer skips it. The claim settles in the `finally`: a start that made no terminal releases it at
once, and one that did keeps it until the agent reports the conversation's id or the terminal
ends.

## Kill Flow (`SESSION_KILL_TRANSIENT`)

The handler calls `SessionManager.endCommandTerminal`, as a phone's stop, the agent-absence sweep
and the end settle do, and throws for a session that is not a Command Terminal.

1. `kill()` the session (a young typed-into one gets its exit sequence and the 1500 ms grace; a Claude session on Windows or Linux is closed at once) and capture `awaitExit`, then detach the session files without deleting them (`detachPreservingFiles`) and `remove()` the row from `SessionManager`, which announces `session-removed`; the handler returns at once, so the window closes immediately
2. Once the process has exited, delete the session directory from disk (best-effort). This is the only delete, so the agent's SessionEnd hook still has a directory to write into

Transient sessions are counted by the `session_spawn` analytics event with `isTransient: true`
(volume) and by `feature_used: command_terminal` (adoption); see [Usage analytics](../../telemetry/usage-analytics.md).
