---
type: Reference
title: System overview
description: Process model with the pty-host, retrieval, embedding and dictation workers, a task move's data flow, and short summaries of the database tables, agent resolution order, transition engine and task template variables, PTY manager constants, board adapters and the mobile bridge.
tags: [architecture, processes, overview]
sources:
  - resource: src/main/pty/host/pty-host-entry.ts
  - resource: src/main/retrieval/worker/retrieval-worker.ts
  - resource: src/main/retrieval/embedder/embed-worker.ts
  - resource: src/main/diagnostics/renderer-recovery.ts
  - resource: src/main/transition-engine/agent-resolver.ts
  - resource: src/main/transition-engine/column-strategy.ts
  - resource: src/main/transition-engine/transition-engine.ts
  - resource: src/main/automations/automation-registry.ts
  - resource: src/shared/automation-manifest.ts
    title: AUTOMATION_MANIFEST
  - resource: src/shared/task-template-vars.ts
    title: Task template variable catalog
  - resource: src/main/pty/session-manager.ts
  - resource: src/main/pty/session-queue.ts
  - resource: src/main/pty/spawn/shell-resolver.ts
  - resource: src/main/pty/readers/file-watcher.ts
  - resource: src/main/agent/adapters/claude/command-builder.ts
  - resource: src/main/boards/board-registry.ts
  - resource: src/main/boards/shared/types.ts
    title: BoardAdapter interface
  - resource: src/preload/preload.ts
---
# System overview

## Process Model

Electron app with two processes:

- **Main process** -- Node.js runtime. Owns the database migrations and project-data writes, the session registry and activity engine, git operations, file I/O, and IPC handlers. Entry point: `src/main/index.ts`.
- **Renderer process** -- Chromium window running React. Communicates exclusively through `window.electronAPI` (context bridge). Entry point: `src/renderer/index.tsx`.
- **Preload script** -- Bridges main↔renderer via `contextBridge.exposeInMainWorld()`. Exposes typed `electronAPI` object. Entry point: `src/preload/preload.ts`.

Context isolation is enabled -- the renderer has no direct access to Node.js APIs.

Work that would block main runs in Electron `utilityProcess` workers, each its own esbuild entry
with a crash policy and stderr capture:

- **`kangentic-pty-host`** (`src/main/pty/host/pty-host-entry.ts`) runs every PTY and the work on
  its output: node-pty, the headless xterm and scrollback ring, backpressure, the raw transcript
  (written on the host's own database connection), and the adapters' output detectors. Main keeps
  `SessionManager` as the facade, mirrors what it reads synchronously, and reads the rest by
  request; output reaches main only for the sessions a renderer shows or a phone streams. The host
  also runs main's one-shot child processes (`off-main-exec.ts`), the probes' raw PTYs
  (`off-main-pty.ts`), the agent CLIs' headless runs (`off-main-cli.ts`: Ask, task summaries,
  auto-name, the warm answer session) and the background-shell watcher's process table, because
  on Windows each spawn's CreateProcess is synchronous on the calling thread. It also scans for
  and stops what a task left running (`reapTaggedProcesses`, `src/main/pty/process-tag/`, loading
  koffi on Windows and macOS), stops one reported process when the user asks, stops a removal's worktree holder by pid and creation time (`SessionManager.stopProcessByCreationTime`, 5 s), and answers which reported processes have ended (`checkReportedProcesses`, by pid and start key, never a scan). It also answers, bounded, once the agent a task's killed or exited shell left running has exited (`awaitAgentExit`, `src/main/pty/host/exited-root-wait.ts`), which a reap, a suspend and `awaitExit` wait on. Forked once at startup, restarted on
  a crash (the lost agent sessions resume), and replaced by the same core running in main after
  five crashes. Measured under a 15 s terminal flood: main 40.6% busy before, 0.6 to 0.7% after.
  See `.claude/rules/pty-host-out-of-process.md`.
- **`kangentic-retrieval`** (`src/main/retrieval/worker/retrieval-worker.ts`) runs every read and
  write of the Knowledge Graph index (the `memory_*`, vec0 and FTS tables, the turn-usage ledger, the usage aggregates behind the dashboard and `kangentic_get_usage_stats` (`usage.read`),
  spawn links, task summaries), the map pass, searches, Ask preparation, storage upkeep, the
  parse and stitch of agent transcripts for the Conversation window, the phone and MCP, the
  Conversation window's history pages, search-hit lookups and timelines (`transcript.page`,
  `transcript.locate`, `transcript.timeline`, one at a time through a queue with depth and wait
  caps and a whole-call deadline, so no read can run into main's call timer), the
  structured transcript archive (`archive.session` on a settled turn, a suspend or an exit, and the
  project-open `archive.sweep`, written whether or not `knowledgeGraph.indexingEnabled` is on), the
  recap tail a resume of a deleted conversation reads (`transcript.recapTail`), the
  per-tool call counts and result-token estimates read from a transcript, and the event-log replay
  behind the one-time tool duration repair. It opens
  the project database on its own connection, after main has migrated it, and runs the WAL's
  PASSIVE checkpoints. Main sends requests through `retrievalClient` and relays the JSON replies.
  See `.claude/rules/retrieval-out-of-process.md`.
- **`kangentic-embeddings`** (`src/main/retrieval/embedder/embed-worker.ts`) runs ONNX inference,
  driven only by `embed-engine.ts` on main (`.claude/rules/central-embedding-engine.md`).
- **`kangentic-dictation`** and **`kangentic-line-count`** run the dictation engine and the diff
  line counts.

Main still writes project data (tasks, sessions, the app tables) inside `writeTransaction`, an
immediate transaction that waits for a worker's write instead of failing with `SQLITE_BUSY`. The
pty host writes one row per raw transcript flush on its own connection.

### Renderer crash recovery

A recoverable renderer death (`render-process-gone` with reason `oom` or `crashed`, never
`clean-exit` or `killed`) reloads the main window automatically instead of leaving it dead and
blank. PTY sessions live in the pty host and are untouched by a renderer-only crash, so a reload
costs the user a repaint, not their work. Reloads are bounded (`RENDERER_RELOAD_MAX` per
`RENDERER_RELOAD_WINDOW_MS`, `src/main/diagnostics/renderer-recovery.ts`): a machine still starved
of memory would kill a freshly reloaded renderer too, so past the bound a native dialog explains
what happened instead of retrying forever. See `src/main/diagnostics/host-memory.ts` (Sentry
DESKTOP-16) for the host memory pressure sampler this pairs with.

## Data Flow

```
User drags task between columns
  → BoardStore.moveTask() -- optimistic UI update
  → IPC task:move
  → Main: update DB positions
  → Main: TransitionEngine runs the SOURCE column's On exit automations
  → Main: check priority rules (To Do? Done? Active session? No session?)
  → Main: TransitionEngine runs the TARGET column's On enter automations
  → Main: the agent starts before the first automation that needs it
  → SessionManager spawns PTY (or queues it)
  → PTY streams output → 16ms batched flush → the renderer's own port to the pty host → xterm render
  → Bridge scripts write status/activity/events files → fs.watch → IPC → Zustand stores
```

## IPC Channels

All channels defined in `src/shared/ipc-channels.ts`. The preload bridge in `src/preload/preload.ts` mirrors them as `window.electronAPI.*`.

## Database

Two SQLite databases through better-sqlite3, in WAL mode with foreign keys on. The global
database (`<configDir>/index.db`, `KANGENTIC_DATA_DIR` overrides the folder) holds the project list,
project groups and global config. Each project's database (`<configDir>/projects/<projectId>.db`,
created on project open and kept outside the project folder) holds its columns, tasks, column
automations and their runs, workflows and task links, sessions, transcripts, handoff records, the
usage ledger, and the Knowledge Graph's index and transcript archive, which only the retrieval
worker reads and writes. Repositories are one class per table with synchronous queries.

Where each database lives and how a connection opens is in
[Storage model](../database/storage-model.md). Every table's columns are in
[Board tables](../database/board-tables.md), [Session tables](../database/session-tables.md) and
[Knowledge Graph tables](../database/knowledge-graph-tables.md), each repository's methods in
[Repositories](../database/repositories.md), and every schema change in
[Migrations](../database/migrations.md).

## Agent Resolution

`src/main/transition-engine/agent-resolver.ts`

`resolveTargetAgent()` determines which agent CLI to use when spawning a session. Resolution priority:

1. **Task `agent_override`** - per-task override set at creation time (highest priority)
2. **Column `agent_override`** - the target swimlane's per-column agent override, *after* the task's Board Profile has been folded over it (see below)
3. **Project `default_agent`** - the project-level default agent setting
4. **Global fallback** - `'claude'`

This function is used by task-move (to detect cross-agent handoff), session-recovery (to respawn with the correct agent), and agent-spawn (to build the right CLI command).

### Board Profiles (the column tier)

Tier 2 is not read straight off the swimlane row. A task may carry a `profile_id` naming a **Board
Profile**: a team-shared, named alternate set of per-column strategy settings, so one task runs
Planning in Opus xhigh and Merge in Sonnet high while another runs the same board more cheaply. The
profile's delta for the destination column is folded over the column's own settings before any tier
above or below it applies.

`src/main/transition-engine/column-strategy.ts` is the **single** place that fold happens
(`resolveColumnStrategy` / `applyProfileToLane`), with `loadTaskProfile`
(`src/main/ipc/helpers/task-profile.ts`) as the one accessor that reads the profile for a task.
Everything is pure and total - it runs inside `runSpawnPreamble` on both spawn chokepoints, and a
profile deleted by a teammate must degrade to the column's own settings rather than wedge an
in-flight task.

Centralising it is not tidiness. The `auto_command` split-brain it replaced shipped for real: the
cold-spawn path honored the per-task tier while the warm live-injection path in `task-move.ts` read
only the destination column, so the same task behaved differently depending on whether the
destination already had a live session. `tests/unit/column-strategy-parity.test.ts` now fails the
build on a spawn-path file that reads a lane's strategy fields without folding the profile first.

Because a profile and the task's Advanced pins are mutually exclusive (enforced in
`TaskRepository`), a profile task has no pins - so `lockAdvancedOverridesOnFirstSpawn` never fires
for it and the ladder survives the task's whole life. See
[Board Profiles](../settings/board-config.md#board-profiles).

## Transition Engine

`src/main/transition-engine/transition-engine.ts`

When a task moves between swimlanes, the IPC handler checks priorities in order:

1. **Target is To Do** → Forget the PR link of a task that did its own work as the move commits, then kill the session, reap what the task left running, and remove the worktree (and the branch when `git.autoCleanup` is on)
2. **Target is Done** → Suspend session (resumable), archive task
3. **Target has auto_spawn=false** → Suspend session
4. **Task has active session** → A model or effort change to a concrete value suspends and respawns so the new `--model` / `--effort` / `--permission-mode` land as CLI flags (never a typed `/model` or `/effort`). Otherwise live-inject the column's message, or keep the session alive (a permission-only change never restarts). Either keep-alive return then runs the destination's On enter group, with the already-delivered message named to the runner so it is not sent twice. See [Transition Engine](automations/transition-engine.md) Priority 3 for the full sub-case order.
5. **Task has no session** → Create worktree (if enabled), run the destination's On enter group with the fallback spawn handed in, so the agent starts right before the first automation that needs it. For resumed sessions, the column's message is preloaded as the resume prompt where the agent's resume takes one, and typed in once the agent is ready otherwise (`SpawnOutcome.unsentPrompt`). For fresh spawns, it is injected via `TerminalSubmitScheduler.scheduleKeystrokes`. Note that escalation to a restart-with-prompt is wired ONLY on the warm-session column move (`task-move.ts`); neither fresh-spawn call site passes an `escalate` handler, so an unconfirmed fresh-spawn message stops at `failed`. See [Command Injection](automations/command-injection.md) for the delivery ladder.

The SOURCE column's On exit group runs ahead of all five, in Phase 1 inside the short lock, after
the DB write and before the priority branches: Priority 1 kills the session, so an exit automation
that needs the agent has to find it still attached. An exit row never aborts the move, and the
group is capped at 60 seconds in aggregate whatever the adapters declare, because holding the
short lock is what wedges that task's next move. Every row is isolated: a failure records its
outcome in `automation_runs` and the next row still runs.

The column's On agent turn end group is not part of a move: `automations/turn-end/turn-end-runner.ts`
runs it when the agent working a task finishes a turn there (`SessionManager`'s `'turn-ended'`),
outside the task lock, one pass per task, and a Move to column row in it moves the task through
`handleTaskMove` like any other mover. See [Automation triggers](automations/triggers.md#on-agent-turn-end).

### Automation adapters

Each type is an adapter under `src/main/automations/adapters/`, registered in
`automation-registry.ts` and declared once in `AUTOMATION_MANIFEST`
(`src/shared/automation-manifest.ts`), which the renderer reads for the picker, the dialog's
fields, and the row sentence. The engine dispatches through the registry, so a new type is one
folder and one manifest entry. See `.claude/rules/automation-adapters.md` for the contract.

| Type | Label | Needs | Timeout | What it does |
|------|-------|-------|---------|-------------|
| `send_message` | Send message to agent | the agent | the scheduler's own 120s | Deliver an interpolated message to the task's agent, through the three delivery rungs |
| `run_script` | Run script | none | 10 minutes by default, per automation | Run a script as a child process in the task's worktree, awaiting the exit and recording the code |
| `webhook` | Call webhook | none | 30s | Send a request with an interpolated body, retried on a transport error, 408, 429 or 5xx with an idempotency key |
| `notify` | Notify me | none | none | Raise one desktop notification through the same path `DesktopNotifier` uses, and push the row's Title and Body to every paired phone (`showAutomationNotification`) |
| `move_to_column` | Move to column | none | none (the move owns its deadlines) | Move the task to a named column, or the next one when none is named, and hand the agent there an optional message. Runs on `turn_end` only, and a row that runs ends its group |
| `spawn_agent` | Start agent | none | none | Legacy. Kept so a row carrying a custom `promptTemplate` still runs; never offered for a new automation |

The retired types are `kill_session`, `create_worktree` and `cleanup_worktree`
(`RETIRED_ACTION_TYPES`). They are gone, rows and all: each was a no-op or a duplicate of the move
path. A hand-written `kangentic.json` naming one is warned and skipped rather than rejected.
`create_pr` survives only in the `ActionType` union and has no adapter and no migration case, so it
takes the same warn-and-skip path without being named in that list.

`send_command` is NOT retired. It is read as an alias for `send_message`, and its `command` field as
an alias for `message`, by the board-config reader (`apply-automations.ts`), the MCP and command
paths, and the legacy-action migration alike, so a hand-written file that predates the rename still
opens. Neither alias is written back. See
[Configuration cascade](../settings/cascade.md#column-automations).

Template variables available: `{{title}}`, `{{description}}`, `{{task_xml}}`, `{{workflow_xml}}` (a workflow task's `<workflow>` block, empty for any other task), `{{taskId}}`, `{{taskNumber}}`, `{{projectPath}}`, `{{projectName}}`, `{{worktreePath}}`, `{{branchName}}`, `{{baseBranch}}`, `{{prUrl}}`, `{{prNumber}}`, `{{prState}}`, `{{issueKey}}`, `{{issueUrl}}`, `{{labels}}`, `{{attachments}}`, `{{port}}`, plus `{{column}}`, `{{fromColumn}}`, `{{toColumn}}`, `{{trigger}}` and `{{agentReply}}` in a column automation, where there is a move to read them from. A workflow agent's first message (Settings > Workflows) has no task: it offers `{{projectName}}`, `{{projectPath}}` and `{{baseBranch}}`, plus its own `{{columns}}` (what each column runs, and how recent tasks went through it) and `{{brief_xml}}` (what the workflow was made from). One declaration (`src/shared/task-template-vars.ts`) drives the `auto_command` field, the `spawn_agent` promptTemplate, and the Automation section's "Template variable" picker, which lists each variable with its description - see [Transition Engine](automations/transition-engine.md#template-variables).

## PTY Session Manager

`src/main/pty/session-manager.ts`

### Spawn Flow

1. Check concurrency limit → queue if full (returns placeholder with `status: 'queued'`)
2. Drain every existing registry row for the task (kill each PTY, preserve its files, carry scrollback over from the most recently started one) so the registry holds one row per task; the full step list is in [Spawn flow](sessions/spawn-flow.md)
3. Resolve shell and arguments (platform-specific)
4. Spawn the PTY in the pty host (a `spawn` request; node-pty runs there, and the reply carries the pid). On Windows node-pty sets the pid after `spawn()` returns, so the host replies once it is set and holds the PTY's output until then; a process that never started replies as a failed spawn (`src/main/pty/host/root-pid-gate.ts`). A ConPTY whose output never connected is spawned once more first, when a second attempt still fits inside main's 15 s spawn budget. node-pty reports that case as an exit carrying -1, from its 5 s connect timeout or an error in its conout worker
5. Start two file watchers (status, events)
6. The host runs the output handler (16ms batched flush)
7. After 100ms delay, write the CLI command to PTY stdin, prefixed with the shell's own clear via `buildSpawnClearPrelude` (every typed command launches an agent, a transient session's included: a Command Terminal or a workflow's agent)

### Output Streaming

All of it runs in the pty host; main relays what a renderer or a phone needs.

- **Buffer:** PTY `onData` accumulates into per-session buffer
- **Flush:** 16ms interval (~60fps). The host sends a flush straight to each renderer that shows the session, on that renderer's own port, and to main as `tap` only for a session a phone streams (`subscribeDataTap`, reference counted). Keystrokes reach the host on the same port, so neither crosses main's event loop (see [Output streaming](sessions/output-streaming.md#input-and-echo-path)). Every other session sends only a coalesced `outputSeen` (no bytes), which the activity engine and the Monitor read.
- **Scrollback:** 512KB ring buffer per session, used to restore terminal content when switching views. Alt-screen sessions and sessions whose ring spans a geometry change restore from the parsed grid instead - see [Output streaming](sessions/output-streaming.md#scrollback-replay). Main reads it by request.

### File Watchers

Two watchers per session, reading files written by bridge scripts:

| Watcher | File | Debounce | Emits |
|---------|------|----------|-------|
| Status | `status.json` | 100ms | `session:usage` -- tokens, cost, model |
| Events | `events.jsonl` | 50ms | `session:event` -- tool_start/end, prompt, idle; `session:activity` -- thinking/idle (derived) |

Events watcher uses byte offset tracking to only read new lines (no full re-read). Activity state (thinking/idle) is derived from event types -- see [Activity event types](activity/event-types.md).

Both go through `FileWatcher` (`src/main/pty/readers/file-watcher.ts`), which pairs an `fs.watch`
fast path with a 1s poll that runs unconditionally as the fallback. Two behaviors are load-bearing
on Windows, where a directory `fs.watch` whose target is deleted emits `rename` at roughly 150k
events/sec forever, with no `error` event, until `close()`:

- Both files are created (empty) before their watcher is constructed, so each watcher arms on the
  FILE. When a watcher has to fall back to watching the parent DIRECTORY (the file does not exist
  yet), it counts raw events ahead of its filename filter and disarms itself on a flood, dropping
  to the poll and re-arming on the file once it appears.
- Deleting a live session's directory is therefore survivable: the watcher releases its handle,
  `repairMissingEventsDir` recreates the directory, and the poll picks the file back up.

### Shell Resolution

Platform-specific detection order in `src/main/pty/spawn/shell-resolver.ts`:

| Platform | Order |
|----------|-------|
| Windows | pwsh → powershell → bash → cmd → WSL distros |
| macOS | zsh → bash → fish → nushell → sh |
| Linux | bash → zsh → fish → dash → nushell → ksh → sh |

Shell-specific adaptations:
- PowerShell: `& ` prefix for command execution, `-NoLogo` flag
- WSL: shell spec split into exe + args
- bash/zsh: `--login` flag
- fish/nushell: no login flag; nushell also prefixes a quoted command head with `^`
- Windows paths converted: Git Bash `/c/path`, WSL `/mnt/c/path`

### Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| MAX_SCROLLBACK | 512 KB | Terminal history per session |
| MAX_EVENTS | 500 | Activity log cap per session |
| Flush interval | 16 ms | Output batching (~60fps) |
| Repaint-settle max wait | 400 ms | Ceiling for the post-resize repaint wait before sampling scrollback |
| Status debounce | 100 ms | Usage file watch |
| Event debounce | 50 ms | Event log + activity state watch |
| PTY exit-callback drain | 25 ms poll, 100 ms settle (400 ms blind), 1500 ms deadline (+ 1500 ms with a deferred kill) | `before-quit` holds the quit until the killed PTY children and the pty host process are gone. The host exits itself once every exit callback has run there, within the drain's deadline less 200 ms, so node-pty's native exit callback is dispatched while JS is still callable. A kill whose child pid was unreadable has no probe and is waited out on the blind budget (Sentry DESKTOP-C; `src/main/pty/shutdown/exit-callback-drain.ts`) |
| Pty host request timeout | 15 s (a spawn or raw spawn: `SPAWN_REQUEST_TIMEOUT_MS`, the budget the host sizes a ConPTY retry against, `src/main/pty/host/root-pid-gate.ts`; an exec: its own timeout plus 5 s, or 10 min for a child with none; a task reap or a leftover-list Stop: 30 s from when its batch starts; a removal's worktree-holder Stop: 5 s, `WORKTREE_HOLDER_STOP_TIMEOUT_MS`) | A request the host never answers rejects with `PtyHostTimeoutError` (`PtyHostExitedError` when the host exited or was down). An exec rejects like a failed child and is never rerun locally, since it may already have run. The host posts `batch-started` as each reap batch or Stop starts, and every request of that method still waiting gets its budget back. A timed-out reap's late answer still reaches its report (`onLateResult`) |
| Pty host heartbeat | 5 s beat, 11 s unresponsive | VS Code's intervals; an unresponsive host is logged |
| Pty host restarts | at once, then 1, 5, 15 s; 5 crashes per 5 min | Past the cap the host core runs in main for the rest of the run |
| KILL_GRACE_MS | 1500 ms | `kill()` on a young session of an agent that is typed into: exit sequence written, force-kill deferred this long (`src/main/pty/lifecycle/deferred-kill.ts`). An agent whose console close is graceful (Claude on Windows and Linux, not in a WSL shell) is closed at once |
| AGENT_EXIT_WAIT_MS | 8000 ms | How long a task reap waits for the agent a killed shell left running to finish exiting before it scans (`src/main/pty/host/exited-root-wait.ts`). It returns as soon as that agent is gone; for a Windows shell that exited on its own the reap waits for the orphan cleanup instead |
| WORKTREE_HOLDER_STOP_TIMEOUT_MS | 5000 ms | How long a worktree removal's reap waits for the host to stop one holder by pid and creation time (`src/main/pty/session-manager.ts`). The removal waits inside its project's git queue, so a hung host holds that queue this long |
| AGENT_EXIT_REQUEST_TIMEOUT_MS | 15000 ms | How long main's reap waits for the host to answer that wait: the longer of `AGENT_EXIT_WAIT_MS` and the orphan cleanup's 10 s grace, plus 5 s (`src/main/pty/host/exited-root-wait.ts`) |
| EXITED_ROOT_LEDGER_MS | 30000 ms | How long an exited task root stays in the pty host's ledger, longer than any `awaitAgentExit` wait on it (`src/main/pty/host/exited-root-wait.ts`) |
| KILL_SNAPSHOT_CAP_MS | 250 ms | POSIX: how long a kill waits for the host's `ps` listing of the shell's agent before the hangup lands anyway; the listing is what the reap's wait polls (`src/main/pty/host/exited-root-wait.ts`) |
| COMMAND_TERMINAL_REAP_DELAY_MS | 5000 ms | How long after a Command Terminal ends its leftover reap starts: a backstop for a root the agent-exit wait holds no ledger for (a WSL shell, the in-process core), past Claude's longest measured exit after a close (`src/main/ipc/helpers/command-terminal-leftovers.ts`) |
| YOUNG_AFTER_ALT_SCREEN_MS | 12000 ms | A session is young this long after its first alt-screen frame (Claude's 10 s boot-canary window plus margin) |
| YOUNG_SINCE_SPAWN_MS | 60000 ms | A session with no alt-screen frame yet is young this long after spawn |
| Idle timeout check | 60000 ms | Polling interval for `checkIdleTimeouts()` |

Stale-thinking detection is no longer a `SessionManager` constant. It now lives in the activity engine watchdog (`src/main/activity-engine/engine/`), which emits a synthetic idle transition after `DEFAULT_STALE_THINKING_TIMEOUT_MS` (180000 ms) of no activity signal while in the "thinking" state. The engine is event-driven, so there is no separate polling timer. See [Activity watchdog](activity/watchdog.md#3-stale-thinking-watchdog-180s).

## Session Queue

`src/main/pty/session-queue.ts`

Limits concurrent PTY sessions (default: 8, configurable via `config.agent.maxConcurrentSessions`).

When a session is requested and the limit is reached, it gets a `queued` status placeholder. When a running session exits or suspends, `notifySlotFreed()` promotes the next queued entry.

Uses a reentrancy-safe double-check loop: a `_processing` flag prevents concurrent promotion, and a `_dirty` flag ensures re-iteration if the queue changed during a spawn await.

## Agent CLI integration

Each agent's adapter builds its own command line, permission flags and merged settings, and writes
whatever global config its CLI needs before a spawn. The contract is in
[Agent adapter interface](../integrations/agents/adapter-interface.md), and each agent's specifics
are in its own concept: for Claude Code, the command builder, the permission mode flags, the
settings merge and the `~/.claude.json` writes are in [Claude Code](../integrations/agents/claude-code.md).

## Session Recovery

On project open (`src/main/transition-engine/session-startup/`), leftover `running` records become `orphaned`, and the latest record of each `(task_id, isolated_swimlane_id)` session is recovered. A suspended, orphaned or OS-killed record with an `agent_session_id` resumes with `--resume`, and a task in an `auto_spawn` column with no session at all gets a fresh agent. The same pipeline, scoped to the lost sessions, runs after a [pty host](sessions/crash-recovery.md#pty-host) crash. The full sequence, its skips and its task-lock re-checks are in [Crash Recovery](sessions/crash-recovery.md#crash-recovery-session-recovery).

## Performance

- **WebGL xterm with an attachment budget** - attempts the WebGL renderer first and recovers from context loss on a retry schedule of 2s, 10s, 30s, 30s, 60s and then every 120s, with no permanent fallback. The tail is sized to outlast Chromium's 3D-API block: after a second GPU-process crash within two minutes Chromium refuses WebGL for the page's domain until the older crash entry ages out, up to 120s later, so the old two-retry ladder always failed in exactly the case it ran in (Sentry DESKTOP-T). A terminal on the DOM renderer that is not budget-suspended always has a retry armed (`retryArmed` and `failedAttempts` in the renderer report). Live WebGL attachments are capped at `WEBGL_ATTACH_BUDGET` (8) page-wide, below Chromium's ~16-context limit: a coordinator (`useFocusedSessionsSync`) keeps the most-recently-focused terminal windows on WebGL and temporarily suspends the rest to the DOM renderer (`suspendedByBudget` in the renderer report - not a context loss, does not advance the retry schedule), re-attaching on focus (`src/renderer/utils/terminal-webgl.ts`, `terminal-visibility.ts`). The coordinator applies that plan BEFORE it publishes the parked set: swapping the renderer changes the cell metric a fit divides by, and a revealed terminal fits itself synchronously, so a fit taken on a renderer the terminal is about to stop using sizes the grid wrong (see the fit-on-the-renderer-you-keep bullet in [Output streaming](sessions/output-streaming.md#grid-width-and-fit))
- **Parked-window write gating** - a terminal window that is off-view (board layer parked on the Backlog view, or occluded by a maximized same-layer window) leaves the focused-session set, so main stops emitting its PTY data at the source; any stragglers are acked-and-dropped by the renderer queue (never parsed, never wedging backpressure). On reveal the terminal repaints from the scrollback ring via `reloadScrollback` (`src/renderer/utils/parked-terminals.ts`, `focused-sessions.ts`). Reveal is the narrow edge: a session can leave the focused set without being parked at all (a detail window a detached monitor owns, a hidden panel, a closed command bar over a transient), so `src/renderer/utils/focused-terminals.ts` repaints on the wider unfocused-to-focused edge too. See the focus-edge catch-up bullet in [Output streaming](sessions/output-streaming.md#focus-catch-up-input-pacing-and-repaint) for the mechanism
- **Serialized terminal construction** - building an xterm (construct + `open` + WebGL context + fit) costs ~75ms, peaking at 130ms, of which the WebGL context alone is 13-29ms on a COLD first context and 7.4-9.6ms once the GPU process is warm (a real session opens warm far more often than cold, so the unqualified range overstated the steady state). A later phase-split pass over that same measurement - the dev-only `init-timing` renderer trace emitted from `initTerminal` (`src/renderer/hooks/useTerminal.ts`) - puts construct plus WebGL context together at 82-87% of the synchronous beat (median 84%), leaving the fit as the small remainder; that split is the ceiling on what reusing a terminal across an ownership handoff could ever save, since the fit is per-host and has to run either way. Each host defers its own init by a frame, but that is the SAME frame for every host mounting in one commit, so a burst (dragging a batch of tasks into a spawning column, restoring a workspace) compounded into a single multi-hundred-ms block with no paint and no input. `src/renderer/utils/terminal-init-queue.ts` runs at most one construction per animation frame, FIFO. It does not reduce the work, it caps the longest single block at one terminal's cost so input keeps being processed between them; a lone terminal still inits on the very next frame. Measured with `kangentic_devtools_event_loop_lag`'s long-frame ring, which is where the ~75ms figure comes from. The queue also holds every construction for the length of a board card drag (the coalescer's `isBoardDragActive`, resumed via `onBoardDragEnd` one frame after the drop frame): the 2026-09-16 drag audit measured a construction at 21 to 42ms on the production build, which is 3 to 6 refresh periods at 144Hz, and the pane a drop spawns mounts while the user is already dragging the next card of a batch. Only construction is held; the xterm write queue streams through a drag on purpose (see [board-drag-perf-audit.md](../audits/board-drag-perf-audit.md)). It holds construction while the user types too: a key pressed in any terminal (`terminal-typing.ts`) holds the pump until the keys pause for 500 ms, so the pane a spawn mounts is not built between two keys. Typing has no drop event, so the hold is capped: after 3 s the oldest queued init is built in the next gap between keys, 40 ms after the last key when its echo has painted, and after 6 s regardless (a held key autorepeats inside that gap). A pointer press or a Ctrl, Alt or Meta shortcut ends the typing, so a terminal a click or a shortcut opens is never held
- **Resize debouncing** -- PTY resize calls debounced at 200ms, suppressed during panel drag
- **Repaint-settled scrollback** - after a geometry-changing resize (cols or rows), `getScrollback` waits for the agent TUI's async repaint to land before sampling, so a restored terminal never replays a frame drawn for a stale geometry; while the agent is actively streaming (never quiesces) the wait settles early on the post-resize repaint marker instead of burning the max-wait ceiling, and a marker-less repaint (Claude's idle default renderer redraws without a full-screen erase) settles on its quiesce once the marker-arrival window has passed rather than riding the whole ceiling (see [Output streaming](sessions/output-streaming.md#scrollback-replay))
- **Activity log** -- plain DOM list instead of xterm. Events flow through JSONL files, not terminal output.
- **Terminal ownership handoff** -- one xterm instance per session at a time prevents duplicate resize calls that corrupt TUI output. Enforced ACROSS renderers, not just within one: main pushes `detail:remoteOwners` (per-recipient, own claims filtered out) so the bottom panel yields its terminal to a detail hosted in the detached Agent Monitor. Without it the panel and the pop-out each mounted an xterm on the same PTY and fitted it to two different widths.
- **Output batching** -- 16ms flush interval prevents per-character IPC overhead
- **Scrollback cap** -- 512KB prevents unbounded memory growth

## Automation Adapters

`src/main/automations/`

One folder per automation type, mirroring `src/main/boards/` and `src/main/pr/`. The registry
dispatches by type, so the transition engine, the IPC handlers and the renderer contain no
per-type branching.

```
src/main/automations/
  shared/
    automation-adapter.ts   # AutomationAdapter contract + AutomationContext
    automation-errors.ts    # the typed failures a run records
  adapters/
    send-message/           # deliver the column's message to the agent
    run-script/             # child process in the task's worktree, awaits the exit
    webhook/                # request with retry, idempotency key, response.ok check
    notify/                 # one desktop notification and one push to every paired phone
    move-to-column/         # move the task at a turn end, then hand on the message
    legacy/spawn-agent.ts   # status 'legacy', never offered for a new automation
  turn-end/                 # the On agent turn end runner, per-task pass tracking, message delivery
  condition-check/          # the Automation agent's one call per group, its prompt and reply parser
  automation-agent.ts       # resolveAutomationAgent and runNamingCall: the one resolver Condition checks and task and terminal names share
  move-target.ts            # resolveMoveTarget: a named column or the next one
  automation-registry.ts    # AutomationRegistry + automationRegistry singleton
  automation-runner.ts      # per-row isolation, timeouts, and the automation_runs record
  automation-run-outcome.ts # rationed failure push to the renderer
  interpolate-config.ts     # per-field escaping from the manifest's `escape`
  column-message.ts         # which row is the column's message, for the profile overlay
```

The manifest (`src/shared/automation-manifest.ts`) is renderer-safe and holds each type's label,
description, icon name, `needs`, fields, timeout and retry policy.
`tests/unit/automation-adapter-parity.test.ts` fails if the registry and the manifest disagree.

## Board Adapters

`src/main/boards/`

Provides external issue import (and future write-back / discovery) for board providers. Mirrors the per-agent adapter layout under `src/main/agent/adapters/`. Each provider lives in its own folder with isolated auth, fetch, and mapping logic; the central registry dispatches by `ExternalSource` id, so IPC handlers contain zero provider-specific branching.

The folder layout, the `BoardAdapter` contract, the registry, the import IPC channels and the steps
to add a provider are in [Board integration](../integrations/boards.md).

## Mobile Bridge

`src/main/mobile-bridge/`

Desktop half of the mobile companion app's secure pairing/transport link, consuming the shared `@kangentic/protocol` package (`packages/protocol/`). Owns the device identity, signed device roster, QR pairing ceremony, capability-verb router, and the outbound relay transport client. Constructed in `src/main/ipc/register-all.ts`, torn down synchronously in `src/main/index.ts`'s `clearPendingTimers`. Machine-global (not project-scoped), backing the Mobile Devices settings tab via the `mobile:*` IPC group in [App IPC channels](ipc/app-channels.md#mobile-bridge-14-channels).

Phase 1 (shipped) covers identity/roster/pairing/transport and the deny-by-default capability router. Phase 2 (shipped) wires all capability-verb handlers to their live main-process data feeds (SessionManager's unfiltered output tap, the transcript service, repositories, `DiffService`, the activity engine's permission-prompt state) and the board/task MCP surface. Phase 3's core (shipped) adds session-lifecycle board pushes, the `register-push` verb, and the E2E-encrypted Expo push notifier (presence suppression, per-category cooldowns, envelope-only content); a direct P2P transport upgrade is a later phase. See [Mobile bridge overview](../integrations/mobile-bridge/overview.md) for the full pairing ceremony, SAS confirmation, roster revocation model, capability verb list, data feeds, push pipeline, ongoing-session crypto, relay transport contract, and phase scope.

## See Also

- [Sessions](sessions/index.md) -- Full state machine, spawn flow, queue, crash recovery
- [Agents](../integrations/agents/index.md) -- Adapter interface, per-agent CLI details, permission modes, hooks, trust
- [Board Integration](../integrations/boards.md) -- BoardAdapter interface, registry, how to add a new provider
- [Mobile Bridge](../integrations/mobile-bridge/index.md) - Pairing ceremony, signed device roster, capability verbs, relay transport
- [Transition Engine](automations/transition-engine.md) -- Automation adapters, triggers, template variables, priority rules
- [Database](../database/index.md) -- Full schema reference, migrations, repository pattern
- [Settings](../settings/index.md) -- Config cascade, all settings keys
- [Platforms](../platforms/index.md) -- Shell resolution, path handling, packaging
- [Activity Detection](activity/index.md) -- Event pipeline, thinking/idle state derivation
- [Worktrees](worktrees/index.md) -- Branch naming, sparse-checkout, hook delivery
