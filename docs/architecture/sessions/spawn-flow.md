---
type: Reference
title: Spawn flow
description: The two spawn chokepoints (spawnAgent and prepareAgentSpawn) and every entry point into them, the engine and SessionManager.doSpawn steps, an agent started hidden during the worktree's setup script and adopted by the spawn, the concurrency queue, isolated session tracks (session_target, session_spawn_strategy), AbortSignal cancellation, and cross-agent handoff.
tags: [sessions, spawn, queue, isolated-sessions, handoff]
sources:
  - resource: src/main/transition-engine/spawn-preamble.ts
  - resource: src/main/ipc/helpers/agent-spawn.ts
  - resource: src/main/transition-engine/transition-engine.ts
  - resource: src/main/transition-engine/session-startup/prepare-spawn.ts
  - resource: src/main/pty/session-manager.ts
  - resource: src/main/pty/session-queue.ts
  - resource: src/main/transition-engine/session-isolation.ts
  - resource: src/shared/session-track.ts
  - resource: src/shared/abort-utils.ts
  - resource: src/main/ipc/handlers/session-resume-controllers.ts
  - resource: src/main/ipc/handlers/task-move.ts
  - resource: src/main/transition-engine/session-startup/auto-spawn.ts
  - resource: src/main/agent/handoff/index.ts
  - resource: src/main/transition-engine/early-agent.ts
---
# Spawn flow

## Spawn entry points

Every way a task agent can be spawned routes through one of TWO chokepoints, and both run the
shared spawn preamble `runSpawnPreamble` (`src/main/transition-engine/spawn-preamble.ts`): lock
the Advanced overrides (`lockAdvancedOverridesOnFirstSpawn`) - on a first-ever spawn, or whenever
the task is leaving a todo-role settings lane - then resolve the target agent
(`resolveTargetAgent`), in that order. Permission mode is resolved by the same
module's `resolveEffectivePermissionMode` (a lane forcing `plan` always wins, else task -> lane
-> global). Enforced by `.claude/rules/spawn-entry-point-parity.md` +
`tests/unit/spawn-entry-point-parity.test.ts`.

| Entry point | Trigger | Route |
|---|---|---|
| Task move (Phase 3 deferred spawn) | drag into an auto_spawn column | `spawnAgent` (`src/main/ipc/helpers/agent-spawn.ts`), `settingsSourceLane` = source lane. A task whose agent is held paused spawns nothing: Priority 4 runs the column's enter rows with `agentPaused` instead, after the cross-agent override clear. A recovery move out of Done keeps the plan, so the worktree Done removed comes back and `spawnAgent` refuses the pause, as an unarchive does |
| Create into a spawn column | New Task dialog / `TASK_CREATE` | `spawnAgent`, `fromSwimlaneId: '*'` |
| Backlog promote | promote from Backlog panel | `spawnAgent`, `fromSwimlaneId: '*'` |
| MCP create (`kangentic_create_task`) | `autoSpawnForTask` | `spawnAgent` |
| Column auto-spawn switched on | a column edit or a Board Profile edit, from either the Board Manager or the MCP `update_column` / profile tools, via `reconcileAutoSpawnChange` | `autoSpawnForTask` -> `spawnAgent` (sequential, skips user-paused, active project only) |
| Unarchive (single + bulk) | Completed Tasks restore / `TASK_UNARCHIVE` | `spawnAgent`, `skipPromptTemplate` + `suppressAutoCommand` (recovery move) |
| Phone Start (`start-session` verb) | "Start again" from the phone's ended state, via `startTaskSession` (`handlers/session-start.ts`), for a task with no session or an exited one | `autoSpawnForTask` -> `spawnAgent`, `explicitStart` (lifts the column's `auto_spawn` default and a user pause, as the desktop Resume button does; the role gate stays) |
| Phone Resume (`start-session` verb) | the same verb for a PAUSED task (a `suspended` registry row), via `startTaskSession` | `resumeTaskSession` (`handlers/session-resume.ts`), the Resume button's own path: no enter automations, no column message, unless the task entered its column after the pause (the next row) |
| Resume after an entry while paused | any Resume (desktop, phone, workflow) of a task that entered its auto_spawn column after its pause | `resumeTaskSession` -> `spawnAgent`, `resumesEntry` (lifts only the held-pause check; the column's own strategy and its enter rows that need the agent). An entry out of Done, a drag back or an unarchive, adds `suppressAutoCommand`, because a recovery move sends the agent nothing |
| Startup crash recovery | project open, `resumeSuspendedSessions` | `prepareAgentSpawn` (`session-startup/prepare-spawn.ts`) |
| Startup reconcile | project open, `autoSpawnTasks` | `prepareAgentSpawn` for a task with session history; a task with none goes to `autoSpawnForTask` -> `spawnAgent` (worktree, then the column's prompt and enter automations), unless those automations already ran this visit. A task a move or a resume is working on is left to it, and so is a task in a paused workflow, except in a pty-host-loss pass (`isTaskWorkflowPaused`). See [Crash recovery](crash-recovery.md) step 8 |

In-place restarts of an existing session (`resumeTaskSession`, which `SESSION_RESUME` and a phone
Resume share, and `restartSessionForSettingsChange`) call the engine directly; they are not
first-spawn entry points. Transient Command Terminal
sessions bypass all of this (not task agents).

## Engine spawn (board-driven path)

1. `spawnAgent` runs the spawn preamble, executes the transition's actions, then falls back to
   `resumeSuspendedSession` if no action created a session.
2. `TransitionEngine.executeSpawnAgent()`:
   - Detect the agent CLI via the resolved adapter
   - Resolve permission mode via `resolveEffectivePermissionMode` (lane `plan` always wins,
     else task pin -> lane -> global)
   - Determine CWD (worktree path or project path)
   - Apply agent-specific pre-spawn global-config state via `adapter.ensureTrust(cwd)`. The
     call is generic (no agent-name branching); each adapter writes its own store: Claude
     `~/.claude.json`, Codex `~/.codex/config.toml` `[projects]`, Gemini and Qwen
     `trustedFolders.json`. Adapters with no such state implement it as a no-op. Trust
     pre-population for the worktree path is the main job, but not the only one: Claude also
     writes `diffSidebarOpen: false` here to keep its fullscreen diff panel closed (see
     [Global Config Writes](../../integrations/agents/claude-code.md#global-config-writes-claudejson)). Every path
     that builds an agent command calls this first, including the Command Terminal.
   - Check for previous suspended session (can resume?)
   - If resuming: reconcile the stored `agent_session_id` against the record's own `status.json` (see [Resume](resume.md#resume)), then use it with `--resume`. The opening message (the column's message, held messages) rides the resume command when the adapter's `resumePromptDelivery` is `command-line`, and is typed in once the agent is ready otherwise ([How the resume prompt arrives](resume.md#how-the-resume-prompt-arrives))
   - If fresh: generate new UUID for `agent_session_id`, use `--session-id`, include prompt
   - Create session directory at `.kangentic/sessions/<agentSessionId>/`
   - Build agent CLI command via `CommandBuilder`
   - For an isolated column's session, read the checkout's HEAD (`TransitionEngineServices.readStartHead`) before the spawn, since the agent may commit in its first seconds, and record it as `sessions.start_head_sha`. A failed read records NULL and never fails the spawn. The main conversation's return recap counts commits from it ([Resume](resume.md#a-return-to-the-main-conversation-opens-on-a-recap)); startup recovery copies it onto the record it writes
   - Call `SessionManager.spawn()`
3. `SessionManager.spawn()`:
   - Check concurrency limit; queue if full (returns `queued` placeholder)
   - If under limit, call `doSpawn()`:
     - Drain EVERY existing registry row for the task, not just the first match (`SessionRegistry.listByTaskId`): kill each PTY, detach its files while preserving them on disk, clear its per-session caches, then carry scrollback and geometry over from the most recently started row that is not the id being reused (a queued placeholder being promoted reuses its own id and has no scrollback). This is what keeps the in-memory registry at one row per task; a spawn that evicted only the first match left a second stale row listed ahead of the live PTY.
     - Resolve shell and arguments (platform-specific)
     - Spawn the PTY in the `kangentic-pty-host` utility process (`PtyHostClient.spawn`; node-pty
       runs only there, see [PTY host](crash-recovery.md#pty-host)). The host reads the carry-over before it drops
       the task's earlier sessions. A Windows ConPTY whose output never connected is spawned once more
       before the host answers (`PtyHostCore.retryLimitFor`; the window is `retryWindowMs` in
       `src/main/pty/host/root-pid-gate.ts`). The retry runs only when at least 6 s remain of main's 15 s
       budget, counted from main's send, and not during a quit, after main killed the PTY, or when the
       session row no longer names this PTY. A probe's raw PTY is never retried. A teardown that cancels the spawn posts
       `cancelSpawn`, so a cancel during the first attempt means no second one. A cancel that lands after
       the second attempt started waits it out, because node-pty holds a kill until a ConPTY's first
       output. A spawn that still fails gets an exited placeholder whose terminal says why
       (`handleSpawnFailure`).
     - Start status file watcher (100ms debounce)
     - Start events file watcher (50ms debounce)
     - The host runs the output handler (16ms batched flush, 512KB scrollback)
     - After 100ms delay, write CLI command to PTY stdin, prefixed with the shell's own clear via `buildSpawnClearPrelude` (every typed command launches an agent, a transient session's included: a Command Terminal or a workflow's agent)

## An agent started during the setup script

A move or an auto-spawn into a new worktree with a Post-Worktree Script starts the agent while the
script runs, and the spawn after the script adopts it instead of launching a second one (the two
modes and their failure handling: [Worktree creation](../worktrees/worktree-creation.md#the-agent-starts-while-the-script-runs)).

1. **Launch.** `createEarlyAgentLauncher` (`agent-spawn.ts`) runs inside the creation's hold,
   without the task lock. It checks what the spawn will check (no session, the column spawns, no
   held pause, no handoff, the column's first enter row needs the agent or there is none),
   resolves the agent, permission and overrides with `previewSpawnPreamble` (the preamble's lock
   computed on a copy and written nowhere), and calls `TransitionEngine.launchEarlyAgent`. That
   launches only a fresh spawn of an agent whose adapter's `firstPromptMayBeTyped` answers true
   for this launch (Claude's does on its fullscreen renderer), with a free concurrency slot and no
   session row for the task: `ensureTrust` for the worktree, the command built with no prompt
   (`resolveLaunch`, the same options a spawn builds), and `sessionManager.spawn` with
   `hiddenUntilAdopted`, `seedIdle` and `inputInAlternateScreen`. Nothing is written to the
   database. Every spawn the engine makes carries that last flag when the adapter answers true, so
   a later background paste waits for the alternate screen too (`awaitInputReady`).
2. **Hidden.** `SessionManager.emit` keeps every event of a hidden session from listeners except
   the raw output signals; its `exit` reaches `awaitExit` alone. It is left out of
   `listSessions`, the caches a renderer syncs from, `findLiveSessionByTaskId` and the idle sweep,
   and `isWritable` is false, so a held-message flush, an MCP send or a phone holds its message
   for the opening prompt. `killByTaskId`, `removeByTaskId` and `killAll` still reach it, so a
   delete or a quit leaves nothing running.
3. **Adopt.** `spawnAgent` passes the handle through `SpawnOverrides.earlyAgent`.
   `executeSpawnAgent` adopts it only for a fresh spawn with no handoff prefix whose launch, built
   with the early agent's ids and no prompt, has the same `launchKey`: same agent, CLI target,
   permission mode, model, effort, folder, launch options. It must also be at its input box: its
   TUI has entered the alternate screen (`awaitAltScreen`, waiting at most until 15 s after its
   launch), since a screen it shows first, such as Claude's approval of a new project MCP server,
   is drawn outside it and would take the typed prompt's Enter. Adopting commits it as a spawn commits
   a new session (`session_id`, the session record with the prompt), then `adoptSession` restarts
   its idle clock and announces it with one `session-changed`. The outcome's `typedOpening` is the
   prompt the command line would have carried.
4. **Type the opening.** `deliverOpeningPromptAndWait` waits for the agent to be on screen and
   its screen to be quiet, then sends the prompt the way every delivery decides (`shouldPaste`): a
   bracketed paste for the task template, keystrokes for one line or a slash command. It is
   awaited, so the column's later messages and held messages go after it.
5. **Discard.** Every path that does not adopt it discards it: a spawn whose launch changed, an
   agent that exited, a Phase 3 re-check that skips the spawn, `spawnAgent`'s own `finally`, the
   move's catch, and a failed or cancelled script inside the creation's hold. A discard is a kill,
   an exit wait taken while the row exists, then a removal, and it runs at most once. The row stays
   hidden until its exit lands, so that exit reaches `awaitExit` alone. A start that reaches the
   task lock before the move does (an MCP or phone start, once the script ends) spawns normally,
   and `SessionManager.spawn` ends the task's hidden agent the same way before it starts its own.

## Queue

- Configurable max concurrent sessions (`config.agent.maxConcurrentSessions`, config default: 8). `SessionManager` builds its `SessionQueue` with that same default, and the configured value is applied through `setMaxConcurrent()` when config loads at startup.
- When the limit is reached, the session receives a `queued` status placeholder.
- When a running session exits or is suspended, `notifySlotFreed()` promotes the next queued entry.
- Reentrancy-safe: a `_processing` flag prevents concurrent promotion, and a `_dirty` flag ensures re-iteration if the queue changed during a spawn await.

## Isolated Sessions (Per-Column Session Model)

A task can run on multiple parallel, independently-resumable sessions. Two orthogonal column fields control the behavior; the pure rules live in `src/main/transition-engine/session-isolation.ts`. Only the first is offered in the UI, on the Column Manager's Conversation card: `session_spawn_strategy` is derived from it by `resolveForceFresh` and is settable by hand in `kangentic.json` only (see [Swimlane-Level Configuration](../../settings/cascade.md#swimlane-level-configuration) for why the two combinations that derivation does not reach are both bad).

- **`session_target`** (`main` | `isolated`, default `main`) - which session track a task runs on. `main` is the task's shared main conversation (resumed as the task moves between normal columns); `isolated` is this column's own separate, context-isolated session, keyed by the swimlane id. Resolved by `resolveSessionTarget` / `resolveIsolatedSwimlaneId`; the discriminator is `sessions.isolated_swimlane_id` (`NULL` = main, swimlane id = isolated).
- **`session_spawn_strategy`** (`create_or_resume` | `always_spawn_new`, default `create_or_resume`) - what to do with that track on entry. `create_or_resume` resumes the track's session if one exists, else spawns it; `always_spawn_new` always spawns fresh, retiring the prior session for that `(task, target)`. Read by `resolveForceFresh`, which is a plain comparison for any stored column: the DB column is `NOT NULL DEFAULT 'create_or_resume'` and `SwimlaneRepository.create` writes a concrete string, so the context-aware fallback in that function never evaluates for a real lane and survives only for a partial object.

  **"Isolated means a fresh pass each entry" is enforced by the WRITERS, not the resolver.** The two interactive writers pair the fields through one shared rule, `snapSpawnStrategyToTarget` (`src/shared/session-track.ts`): moving a column to `isolated` carries its strategy to `always_spawn_new`, and back to `main` returns it to `create_or_resume`, in both cases only when the strategy still sits at the outgoing track's default, so a deliberate pairing survives. The Column Manager's Session select and the MCP `create_column` / `update_column` handlers both call it, which is what keeps an agent-created review column identical to a hand-made one. The `kangentic.json` sync does NOT pair them: `apply-config.ts` applies each key as written. An app-written file always carries both, since `build-config.ts` emits both whenever either is non-default, but a hand-edited one naming only `sessionTarget: isolated` lands as `isolated` + `create_or_resume`.

The four combinations:

| `session_target` | `session_spawn_strategy` | Behavior |
|---|---|---|
| `main` | `create_or_resume` | Resume the task's main session, or start it (the default) |
| `main` | `always_spawn_new` | Restart the main session from scratch each entry (reset-main) |
| `isolated` | `create_or_resume` | Resume this column's isolated session, or start it (a persistent isolated track) |
| `isolated` | `always_spawn_new` | A fresh, independent pass every entry (the reviewer archetype) |

Both fields are enums so future tracks/strategies need no schema migration.

**An isolated session is context-isolated.** It does NOT inherit the main session's conversation. This is the point of the feature: pairing `session_target: isolated` (with the default `always_spawn_new`) and `auto_command: /code-review` yields an independent reviewer that judges the current diff without the generator's reasoning trail. (This is distinct from Claude Code's own `/fork` / `--fork-session`, which *inherit* the conversation; we deliberately do not.) "Restart the conversation" within a session is otherwise left to the agent's native `/clear` / `/compact`.

**One active PTY per task** is preserved. The worktree is shared across a task's sessions (same `task.worktree_path`), so an isolated session's edits are real and persist; the main session sees the changed tree but not the isolated conversation. When the main conversation resumes after one, its opening message says what the isolated sessions committed and the final message each ended on (the return recap, see [Resume](resume.md#a-return-to-the-main-conversation-opens-on-a-recap)).

**`always_spawn_new` applies on column entry only.** An app restart / pause-resume of an in-progress session still resumes it (the recovery path is unaffected), so a crash never discards active work. The Resume path (`resumeTaskSession`) and the in-place settings restart (`restartSessionForSettingsChange`) pass `forceFresh: false` over what `resolveSpawnOverrides` derives from the column. They used to forward the column's `true`, so a Resume in a reviewer column retired the paused conversation and started a blank one.

Lifecycle on task move (`task-move.ts`, the session switch branch inside Priority 3):

- **Enter an isolated column from a live main session**: suspend the main session (preserve `agent_session_id`), then Phase 3 spawns/resumes the isolated session and runs its `auto_command`. With `always_spawn_new` (the isolated default) it spawns fresh each entry, retiring the prior pass.
- **Leave an isolated column for a normal column**: suspend the isolated session (resumable), then Phase 3 resumes the **main** session, which opens on the return recap when the isolated session left a commit or a final message.
- **Reset-main / recycle**: an `always_spawn_new` column forces a fresh spawn on its target track even when the live session is already on that track, so the switch fires on `resolveForceFresh(toLane)`, not only on a target change.
- The target + spawn policy are derived from the destination column in `resolveSpawnOverrides`, threaded through `SpawnOverrides.isolatedSwimlaneId` / `SpawnOverrides.forceFresh` into `resolveSpawnIntent` (which retires the prior record on a forced-fresh entry) and `sessionRepo.insert`. The terminal tab badges an isolated session as "Isolated" vs "Main".
- **A switch the live session asked for itself** (its own `kangentic_move_task`, the way a main session sends its task to Code Review) suspends that session only once the turn that made the move ends, so the move stays in its conversation. The new track's spawn waits behind it. See [A call that ends the caller's own session](suspend-and-cleanup.md#a-call-that-ends-the-callers-own-session).

## Cross-Agent Handoff

When a task moves to a column where `resolveTargetAgent()` returns a different agent than the current session:

1. The current session is suspended (Priority 3a in the [Transition Engine](../automations/transition-engine.md))
2. `spawnAgent()` (`src/main/ipc/helpers/agent-spawn.ts`) asks the source agent's adapter for its native session history file (`locateSessionHistoryFile`)
3. `buildSessionHistoryReference()` turns that path into a `handoffPromptPrefix` that tells the target agent to read the file, and the target agent is spawned with it prepended to the task prompt
4. A `handoffs` record tracks the from and to agents and sessions

The full flow, the per-agent file locations and the passthrough toggle are in [Cross-agent handoff](../../integrations/agents/handoff.md).

The handoff is transparent to the user - the task card shows spawn progress phases (`packaging-handoff`, `detecting-agent`, `starting-agent`) and the shimmer overlay lifts when the new agent is on screen (`SessionManager.markAgentReady`, see [The launch overlay](../../integrations/agents/adapter-interface.md#the-launch-overlay)).

## AbortSignal Pattern

When a task moves rapidly between columns (e.g. drag-and-drop corrections), spawns from earlier transitions can become stale before they complete. The transition engine uses `AbortSignal` to cancel in-flight spawns:

1. Each task move creates an `AbortController` for the transition
2. If the same task moves again before the previous transition completes, the old controller is aborted
3. The `AbortSignal` is threaded through `executeTransition()`, `executeAction()`, and `executeSpawnAgent()`
4. At each async boundary (CLI detection, worktree creation, PTY spawn), the signal is checked via `signal?.throwIfAborted()`
5. If aborted, the spawn stops immediately - no PTY process is created

The `isAbortError()` utility in `src/shared/abort-utils.ts` provides a type guard for distinguishing abort errors from real errors in catch blocks.

A phone Resume of a paused task (`start-session` through `resumeTaskSession`) is a `SESSION_RESUME` in every respect, including the abort: it cancels an in-flight resume for the task exactly as a second desktop Resume click does, by decision, so the phone mirrors the desktop. A resume the task's row already refuses (To Do, Done, archived) cancels nothing: `resumeRefusalBeforeLock` rejects it before the abort. The one difference is how a failure shows. The desktop's invoke rejects and the renderer toasts it. The phone was answered on acceptance, so its `startTaskSession` passes an `onFailed` hook that sends the desktop spawn-blocked notice for a worktree or engine failure, as a failed phone Start does. A cancelled resume cleans up no session state, for the reason `autoSpawnForTask`'s abort gives below, and each canceller settles the task under its own lock. It used to call `removeByTaskId`, which dropped the task's paused row while the newer resume was still in its git phase: a paired phone's feed on that row ended with no `successorSessionId`, and a Pause that cancelled the resume lost the row it meant to keep.

The board-driven spawn chokepoint `autoSpawnForTask` (`src/main/ipc/helpers/agent-spawn.ts`: the MCP create, the auto-spawn reconcile, and the phone's `start-session` verb for a task with no session or an exited one) is cancellable the same way. It registers an `AbortController` on the per-task registry `SESSION_RESUME` uses (`handlers/session-resume-controllers.ts`), so `SESSION_SUSPEND`, `SESSION_RESET`, a newer `SESSION_RESUME`, and a project relocation cancel its in-flight git phase through `abortInFlightResume`, and the signal reaches `ensureTaskWorktree`, `ensureTaskBranchCheckout`, and `spawnAgent`. It registers WITHOUT aborting an existing controller first, unlike `SESSION_RESUME`: a phone Start never cancels desktop work, and two starts converge on one session through the gates below. The registry holds every in-flight controller per task (a `Set`, not one slot), so that second registration does not displace the desktop resume's controller: the next Pause reaches both. `tests/unit/session-resume-controllers.test.ts` pins that. Its lock is split the way `SESSION_RESUME`'s is: Phase 1 runs the gates (column re-check, live-session check, profile fold, `auto_spawn`, role) under `withTaskLock`, Phase 2 releases it for the worktree ensure and branch checkout (the git work serialized per project by `WorktreeManager.projectQueues`, and a new worktree's setup script runs after that, held per worktree path by the creation registry), and Phase 3 re-acquires it, re-runs the same gates as the compare-and-swap, and spawns. Holding the lock across the fetch used to make a desktop Pause or move on the same task wait behind a phone Start. An abort is logged and swallowed, never counted as a spawn failure, and cleans up no session state: the engine's last abort checkpoint precedes the PTY spawn, and the `session_id` write follows it with no further checkpoint, so an abort never leaves a half-written session for the aborter to trip over.
