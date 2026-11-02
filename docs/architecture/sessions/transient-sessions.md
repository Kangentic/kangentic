---
type: Reference
title: Transient sessions
description: "How Command Terminals and workflow agents run as transient sessions with no DB row: startCommandTerminal's slot claim and four-terminal cap, cold-spawn checkout, spawn-failed handling, resuming an earlier conversation, the pass that restores running terminals after a restart or a pty host crash, the kill flow, and rebuilding slots after a renderer reload."
tags: [sessions, transient, command-terminal, slots]
sources:
  - resource: src/main/ipc/handlers/transient-sessions.ts
  - resource: src/main/ipc/handlers/command-terminal-restore.ts
  - resource: src/renderer/stores/session-store/transient-recovery.ts
  - resource: src/shared/command-terminal-name.ts
  - resource: src/main/pty/session-registry.ts
    title: ManagedSession.commandTerminalNamedByUser and its mapping in toSession
---
# Transient sessions

Command Terminals are ephemeral agent terminals spawned from the command bar (Ctrl+Shift+P) or by a paired phone's `command-terminal` start. They are transient sessions, and they differ from task-bound sessions in several ways:

- **No task association** - run at the project root with no Kanban task
- **No DB persistence** - no session record in the database
- **No resume in place** - a suspend ends the terminal, since no task record keeps its place. What survives is the conversation: `CommandTerminalHistory` records each one the terminal held (`command_terminal_history`), and a later start can resume it by id (see [Resume](#resume)). A quit is not an end: the next launch brings a running terminal back as itself (see [Restored after a restart](#restored-after-a-restart))
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
2. Create a session directory at `.kangentic/sessions/<sessionId>/` for bridge files. It is named by the session, not by the tag: a restored terminal keeps its tag, and the project-open sweep running in the same cold open would delete last run's directory
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
namer skips it. The command starts on the model and effort the conversation's context bar last
set, else the project's defaults. A picked model is saved only once the agent's status shows it
(a declined switch saves nothing, and a typed `/model` is never seen), see the
[`command_terminal_history` table](../../database/session-tables.md#command_terminal_history-table). The claim settles in the `finally`: a start that made no terminal
releases it at once, and one that did keeps it until the agent reports the conversation's id or the
terminal ends.

### Restored after a restart

`command-terminal-restore.ts` (`src/main/ipc/handlers/`) brings back what was running when the app
last went away. The signal is a used `command_terminal_history` row with no `ended_at`. A quit
removes no registry row, so a terminal open at a quit leaves its row open, a crash or an OS kill
leaves the same state, and nothing runs on the synchronous quit path. The pass is gated on
`agent.autoResumeSessionsOnRestart`, with no setting of its own, and runs for every project, so the
sidebar count and a phone see the terminals. The cost is real: up to four idle agents per project at
about 1.15 GB of commit each, and no pause reaches them.

Reading Earlier erases the signal: `list()` deletes untouched open rows and stamps the rest ended.
So the pass has two halves:

- **The claim** (`claimCommandTerminalRestore`) is synchronous and runs once per launch, on the first
  touch from any caller: a cold open, `list()`, a phone's `list-earlier`, the panel's wait. It reads
  the newest `MAX_COMMAND_TERMINALS` open rows and `claimResume`s each, so `list()` reads them as
  live. `list()` calls it and waits for nothing more, since the spawn phase can run past a phone's
  10 s budget.
- **The start** (`startCommandTerminalRestore`) runs once, only from the three cold-open paths in
  `handlers/projects.ts`, after `resumeSuspendedSessions` and in a `finally`, so tasks keep first
  claim on `maxConcurrentSessions` and a chain that throws still settles its claims. It starts one
  row at a time, saved slots first, through `startCommandTerminal` with a third argument
  (`CommandTerminalRestoreStart`) that neither IPC nor a phone can reach. So the cap, the reservation,
  the name seed, the rule that a resume never fetches or checks out, and the stop of a `/bg`
  background session all hold, and there is no new spawn path.

The third argument takes the claim as held, keeps the saved process tag so the terminal's Stop still
reaches what it left running, starts at the saved grid (`restoredGrid`) so an agent restored with
the panel closed composes at it, and skips the `command_terminal` feature count. A `slot-taken`
falls back to the lowest free slot. Any other refusal logs one line and settles the claim, and the
conversation stays in Earlier. A fresh terminal never takes the place of one that cannot resume:
it would run a cold start's checkout with nobody at the desk.

With the panel closed a restored terminal behaves like a phone's. The toggle and sidebar count
update live, and the next open adopts it. `useCommandBar.open()` and the detached window's mount
gate wait on `commandTerminalRestore:wait` first, because a default window would otherwise start
fresh in a slot the restore is about to take. The wait has a 10 s ceiling, so a wedged pass never
leaves the shortcut dead, and past 150 ms the title-bar toggle shows a spinner, so a press at boot
is answered. A panel left showing at quit reopens (`reopen-panel.ts`, see
[Command Terminal](../renderer/command-terminal.md#after-a-restart)).

At the session cap a restored terminal starts `queued` and holds its slot, so the reconcile,
`findAdoptableTransientSession` and `planTransientRecovery` count a queued terminal as live. Its
promotion replaces the placeholder row, so `performSpawn` carries the name and its
`commandTerminalNamedByUser` mark across.

A pty host crash takes the same route. A terminal's row goes as its PTY's exit is reported, before
`pty-host-lost` fires, so a `session-removed` listener in `register-all.ts` captures it by
`PTY_HOST_LOST_EXIT_CODE` and claims the conversation in that emit, or the rail would offer it in
Earlier while the host restarts. `recoverSessionsAfterPtyHostLoss` restores them after the tasks,
even when task recovery throws, and `commandTerminalRestore:wait` holds a panel open until then, or
its default window would start fresh in a slot the restore is about to take. The leftover reaper
skips such a terminal (`isRestorableAfterHostLoss`), since what it left running
is still its own. One that does not come back has ended, so `restoreLostCommandTerminals` reaps it
the way the reaper would have: the agent CLI's background session first, then its leftovers. A
refused restore at boot reaps nothing, as a quit reaps nothing. The crash closes the terminals'
windows, so the panel hides and the next open adopts them.

## Kill Flow (`SESSION_KILL_TRANSIENT`)

The handler calls `SessionManager.endCommandTerminal`, as a phone's stop, the agent-absence sweep
and the end settle do, and throws for a session that is not a Command Terminal.

1. `kill()` the session (a young typed-into one gets its exit sequence and the 1500 ms grace; a Claude session on Windows or Linux is closed at once) and capture `awaitExit`, then detach the session files without deleting them (`detachPreservingFiles`) and `remove()` the row from `SessionManager`, which announces `session-removed`; the handler returns at once, so the window closes immediately
2. Once the process has exited, delete the session directory from disk (best-effort). This is the only delete, so the agent's SessionEnd hook still has a directory to write into

Transient sessions are counted by the `session_spawn` analytics event with `isTransient: true`
(volume) and by `feature_used: command_terminal` (adoption); see [Usage analytics](../../telemetry/usage-analytics.md).
