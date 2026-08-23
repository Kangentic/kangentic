# Session Lifecycle

This document describes the full session state machine in Kangentic, covering how Claude Code CLI sessions are spawned, queued, suspended, resumed, and recovered.

## State Machine

There are two separate state representations:

- **`SessionStatus`** -- in-memory runtime state of a `ManagedSession` inside `SessionManager`. Values: `running`, `queued`, `exited`, `suspended`.
- **`SessionRecordStatus`** -- persisted in the SQLite database as a `SessionRecord`. Values: `running`, `queued`, `suspended`, `exited`, `orphaned`.

The in-memory `SessionStatus` does not include `orphaned` (that is a DB-only concept discovered on next launch). Both types include `queued` - the DB record is created with `status: 'queued'` at spawn time and promoted to `running` when a concurrency slot opens.

```
                  +----------+
                  |  queued  |
                  +----+-----+
                       |
              slot opens (SessionQueue promotes)
                       |
                       v
+------------+    +----------+    +-----------+
| suspended  |<---| running  |--->|  exited   |
+-----+------+    +----+-----+    +-----------+
      |                |                ^
      |                | app crashes    | killed while queued
      |                v                |
      |           +----------+    +-----+----+
      +---------->| orphaned |<---|  queued   |
   (recovery)    +----------+  (app crashes)
```

### States

| State | Scope | Description |
|-------|-------|-------------|
| `queued` | Both | Waiting for a concurrency slot to open |
| `running` | Both | PTY is live, Claude Code CLI process is active |
| `suspended` | Both | PTY killed, but session ID and files preserved for resume |
| `exited` | Both | Process exited naturally or was killed; terminal state |
| `orphaned` | DB only | App crashed while session was running; discovered on next launch |

### Transitions

| From | To | Trigger |
|------|----|---------|
| `queued` | `running` | Concurrency slot opens, `SessionQueue` promotes |
| `queued` | `exited` | Session killed while still queued |
| `running` | `suspended` | Task moved to Done or `auto_spawn=false` column |
| `running` | `suspended` | A column or Board Profile edit flips `auto_spawn` to false while the task is already sitting there, with no move at all (`reconcileAutoSpawnChange`, `suspended_by='system'`) |
| `running` | `exited` | Task moved to To Do (full cleanup via `cleanupTaskSession`) |
| `running` | `exited` | Process exits naturally or is killed. Every `-> exited` transition also destroys any offscreen browser lanes that session opened (`destroyLanesForSession`), which is the guarantee that lanes cannot outlive their agent - see [Embedded Browser](embedded-browser.md) decision 29 |
| `running` | `exited` | The agent CLI exited on its own while its shell PTY survived, so no PTY exit ever fired. The bg-shell watcher's [agent-absence sweep](#a-session-whose-agent-exited-under-a-surviving-shell) confirms it over two probes and retires the session |
| `running` | `orphaned` | App crashes, leftover `running` DB record found on next launch |
| `queued` | `orphaned` | App crashes, leftover `queued` DB record found on next launch |
| `suspended` | `running` | Task moved to active column, resumed via `--resume` |
| `suspended` | `exited` | Replaced by a new session on resume (`retireRecord`) |
| `orphaned` | `running` | Session recovery on project open |
| `orphaned` | `exited` | Recovery dedup, or failed recovery (`retireRecord`) |
| `orphaned` | `suspended` | Pause-on-restart setting upgrades a crashed session (`markRecordSuspended`) |
| `exited` | `running` | OS-killed (abnormal `exit_code`) session resumed by recovery on project open (`getInterruptedExited`) |
| `exited` | `suspended` | Interrupted-exited record CAS-upgraded by recovery (non-target / non-auto-spawn / auto-resume-off), or a PTY exit during app shutdown (onExit hardening) |
| `running` | `suspended` | App shutdown race: PTY exits while `isShuttingDown()` (onExit hardening keeps it resumable) |

## Spawn Flow

### Spawn entry points

Every way a task agent can be spawned routes through one of TWO chokepoints, and both run the
shared spawn preamble `runSpawnPreamble` (`src/main/transition-engine/spawn-preamble.ts`): lock
the Advanced overrides on a first-ever spawn (`lockAdvancedOverridesOnFirstSpawn`), then resolve
the target agent (`resolveTargetAgent`), in that order. Permission mode is resolved by the same
module's `resolveEffectivePermissionMode` (a lane forcing `plan` always wins, else task -> lane
-> global). Enforced by `.claude/rules/spawn-entry-point-parity.md` +
`tests/unit/spawn-entry-point-parity.test.ts`.

| Entry point | Trigger | Route |
|---|---|---|
| Task move (Phase 3 deferred spawn) | drag into an auto_spawn column | `spawnAgent` (`src/main/ipc/helpers/agent-spawn.ts`), `settingsSourceLane` = source lane |
| Create into a spawn column | New Task dialog / `TASK_CREATE` | `spawnAgent`, `fromSwimlaneId: '*'` |
| Backlog promote | promote from Backlog panel | `spawnAgent`, `fromSwimlaneId: '*'` |
| MCP create (`kangentic_create_task`) | `autoSpawnForTask` | `spawnAgent` |
| Column auto-spawn switched on | a column edit or a Board Profile edit, from either the Board Manager or the MCP `update_column` / profile tools, via `reconcileAutoSpawnChange` | `autoSpawnForTask` -> `spawnAgent` (sequential, skips user-paused, active project only) |
| Unarchive (single + bulk) | Completed Tasks restore / `TASK_UNARCHIVE` | `spawnAgent`, `skipPromptTemplate` + `suppressAutoCommand` (recovery move) |
| Startup crash recovery | project open, `resumeSuspendedSessions` | `prepareAgentSpawn` (`session-startup/prepare-spawn.ts`) |
| Startup reconcile | project open, `autoSpawnTasks` | `prepareAgentSpawn` |

In-place restarts of an existing session (`SESSION_RESUME`, `restartSessionForSettingsChange`)
call the engine directly; they are not first-spawn entry points. Transient Command Terminal
sessions bypass all of this (not task agents).

### Engine spawn (board-driven path)

1. `spawnAgent` runs the spawn preamble, executes the transition's actions, then falls back to
   `resumeSuspendedSession` if no action created a session.
2. `TransitionEngine.executeSpawnAgent()`:
   - Detect the agent CLI via the resolved adapter
   - Resolve permission mode via `resolveEffectivePermissionMode` (lane `plan` always wins,
     else task pin -> lane -> global)
   - Determine CWD (worktree path or project path)
   - Pre-populate agent-specific trust for the worktree path via `adapter.ensureTrust(cwd)`. The
     call is generic (no agent-name branching); each adapter writes its own store: Claude
     `~/.claude.json`, Codex `~/.codex/config.toml` `[projects]`, Gemini and Qwen
     `trustedFolders.json`. Adapters with no trust system implement it as a no-op.
   - Check for previous suspended session (can resume?)
   - If resuming: reconcile the stored `agent_session_id` against the record's own `status.json` (see [Resume](#resume)), then use it with `--resume`, no prompt
   - If fresh: generate new UUID for `agent_session_id`, use `--session-id`, include prompt
   - Create session directory at `.kangentic/sessions/<agentSessionId>/`
   - Build agent CLI command via `CommandBuilder`
   - Call `SessionManager.spawn()`
3. `SessionManager.spawn()`:
   - Check concurrency limit; queue if full (returns `queued` placeholder)
   - If under limit, call `doSpawn()`:
     - Kill any existing PTY for the same task (orphan dedup)
     - Resolve shell and arguments (platform-specific)
     - Spawn PTY via `node-pty`
     - Start status file watcher (100ms debounce)
     - Start events file watcher (50ms debounce)
     - Set up output handler (16ms batched flush, 512KB scrollback)
     - After 100ms delay, write CLI command to PTY stdin

## Queue

- Configurable max concurrent sessions (`config.agent.maxConcurrentSessions`, config default: 8). The `SessionQueue` constructor initializes with a hardcoded limit of 5; the actual config value is applied via `setMaxConcurrent()` when config loads at startup.
- When the limit is reached, the session receives a `queued` status placeholder.
- When a running session exits or is suspended, `notifySlotFreed()` promotes the next queued entry.
- Reentrancy-safe: a `_processing` flag prevents concurrent promotion, and a `_dirty` flag ensures re-iteration if the queue changed during a spawn await.

## Suspend and Cleanup

Session teardown varies by target column:

- **To Do** (role=`todo`), via `TASK_MOVE` - full cleanup via `cleanupTaskResources()`: kills the PTY (via `SessionManager.remove()`), deletes session files from disk, deletes all session DB records for the task, and then removes the worktree and (when `git.autoCleanup` is on) force-deletes the branch. Destructive, which is why the drop is gated behind a pending-changes confirmation. Moving back to an active column spawns a fresh session.
- **To Do** (role=`todo`), via `TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE` (restore from Done) - the SESSION-only half, `cleanupTaskSession()`. The worktree and branch are left alone. Without this the task keeps the session Done deliberately suspended, and since `listSessions()` has no status filter the restored card renders "Paused" for the rest of the app session. It is not the full `cleanupTaskResources()` on purpose: `deleteTaskWorktree` nulls `worktree_path` only when the Done-time removal SUCCEEDED, so a task whose worktree was pinned at Done time (routine on Windows) still carries both fields, and the full helper would re-attempt the removal and force-delete the branch holding its committed work with no confirmation on this route.
- **Done** (role=`done`) - suspends session (preserves for resume via `SessionManager.suspend()`), archives task, and deletes the worktree to reclaim disk while preserving `branch_name` and the session records. The DB record is marked `suspended` so the session can be resumed if the task is later unarchived into an auto-spawn column. That unarchive is the ONLY route back: resuming in place is refused for a Done or archived task (see [Where resume is refused](#where-resume-is-refused)), since it would recreate the worktree this move deleted.
- **Any column with `auto_spawn=false`** - suspends session (same as Done, but without archiving). A restore into such a column keeps the suspended session and its Resume affordance; only a `role=todo` target resets it.

### What is preserved on suspend (Done / auto_spawn=false)

- `agent_session_id` (for `--resume` on next spawn)
- Worktree directory and branch
- Session files on disk (`status.json`, `events.jsonl`, `settings.json`)
- Scrollback buffer in memory

### What is destroyed on To Do cleanup

- PTY process (force-killed)
- Session files on disk (deleted)
- All session DB records for the task (deleted)
- In-memory caches (usage, activity, events) for the session

### SessionManager.suspend() flow

1. Remove the adapter's hooks from the project settings file (idempotent with `onExit`)
2. Close file watchers and detach telemetry readers, preserving the files for resume
3. Flush the transcript to the DB
4. Emit a synthetic `session_end` event (the agent's own hook will not fire on a kill)
5. Clear subagent depth tracking
6. Mark status as `suspended`
7. **Emit `session-changed`** - before the shutdown below, not after
8. Release backpressure so the agent's exit-sequence output is not held back
9. `gracefulPtyShutdown`: send the exit sequence, wait up to 1500ms for a natural exit, then
   force-kill and wait up to 1500ms more for kill propagation
10. Last-resort scrollback scan for an agent session id not yet captured
11. **Emit `session-changed` again** - now carrying the post-shutdown session
12. Notify the queue (slot freed)

Steps 7 and 11 are a deliberate DOUBLE emit, and both are load-bearing:

- Step 7 exists because the bottom panel's tab set is `status === 'running'`
  (`derivePanelSessions`). Emitting only at the end left a tab for a session the user had already
  watched leave the board, for the whole of step 9. A user-initiated Pause never showed that,
  because the renderer store writes the suspended status optimistically; a main-driven suspend
  (move to Done, idle timeout, settings restart) had no such write and wore the full delay.
- Step 11 carries state that only exists after the shutdown, including an agent session id
  recovered by step 10.

The gap between them is what sets `FINALIZE_DEBOUNCE_MS` (3500) in
`src/main/retrieval/retrieval-service.ts`: finalize indexing is debounced per session, and the
two reports can be up to 3000ms apart on a force-kill, so a shorter window would fail to coalesce
them on exactly the slow path where the later read matters most.

## Resume

### Where resume is refused

`SESSION_RESUME` (the task detail's Pause/Resume toggle) restarts a suspended session **in
place**, in the task's current column. It is refused for three states, resolved by one shared
predicate (`src/shared/session-resume-eligibility.ts`) that both the main-process handler and the
task detail read, and whose role set startup recovery shares:

| State | Why |
|---|---|
| Lane role `todo` | A To Do card has not started; its detail opens straight into the edit form |
| Lane role `done` | The task is complete. The route back is to move it OUT of Done |
| `archived_at` set | Same, for a task archived without a live Done-role lane |

Resuming a completed task in place would recreate the worktree the move to Done had just deleted
and leave the task archived AND running at once, with no board card to show for it. The supported
route is the recovery move below, which unarchives first and then spawns through the normal
chokepoint, so the refusal never applies to it. The main-process guard is the contract; the task
detail hides the control so it is never offered. Pausing a session that is genuinely live is NOT
refused in any of those states, so a stray agent can still be stopped from the window showing it.

### A resume with no conversation behind it is downgraded to fresh

Kangentic pre-specifies `--session-id` for Claude and persists it on the session record AT SPAWN
TIME, before the agent has done anything, while the agent CLI writes its transcript on the first
turn. A session that ends before that turn therefore leaves a resumable-looking record pointing at
a conversation that does not exist.

That is reachable in seconds of ordinary use: the recovery move out of Done spawns command-free,
so the agent comes up idle with nothing to do, and moving the task back to Done before typing
suspends it with its id intact. Every later entry into an auto-spawn column then issued
`--resume <id>`, the CLI answered "No conversation found with session ID", and the user was left on
a bare shell with the record still reading `running` (the shell PTY outlives the CLI).

`isResumeConversationAbsent` (`src/main/transition-engine/resume-conversation-guard.ts`) now
downgrades that spawn to fresh at both chokepoints (`executeSpawnAgent` and `prepareAgentSpawn`).
It fires only on positive evidence of an empty conversation. Two things must hold together:

- the transcript path was reported by the AGENT itself, never derived by Kangentic;
- the same report independently shows the conversation never took a turn;

and then the file that report names must be absent.

The evidence comes from either of two agent-written files in Kangentic's own session directory,
which differ in how each answers the turn question:

| Source | Transcript path | "Never took a turn" means |
|---|---|---|
| `status.json` (preferred) | the status line's `transcript_path` | no tokens and no cost |
| `events.jsonl` (fallback) | `transcript_path` inside the SessionStart hook payload | no event beyond `session_start` / `session_end` |

The fallback exists because the status line only runs once the TUI is up, so a CLI killed in its
first second leaves none. The SessionStart hook fires far earlier. A missing status file therefore
does NOT end the check: it falls through to the hook, and only a record that yields neither report
is skipped.

The guard returns false - resuming exactly as before - when the adapter has no status pipeline,
when the project path is unknown, or when no record yields a usable report at all. Absence of
evidence is never evidence, so a conversation that had turns is never discarded. Mocked CLIs land
on that path structurally, which is what kept the E2E resume specs passing. This is deliberately
narrower than the `canResumeSession` transcript-presence guard reverted in #255 (see
docs/adapter-session-history.md), whose false misses silently lost real conversations.

The board chokepoint walks every record sharing the conversation's `agent_session_id`, newest
first, because a failed resume writes no report of its own and an already-poisoned task would
otherwise stay broken forever. Startup recovery passes only the record it is recovering: it holds
no repository handle to walk the lineage, and a record recovered there ran until the crash, so it
normally has its own status report.

### A session whose agent exited under a surviving shell

Kangentic spawns a SHELL and writes the agent CLI command to its stdin, so the agent CLI is a
CHILD of the PTY root, never the root itself (`getSessionRootPid` returns `session.pty.pid`). When
the CLI exits on its own - a user typing `/exit`, a CLI crash, a launch that fails - the shell
survives, the PTY never fires `onExit`, and nothing marks the session finished. The record stays
`running` with `suspended_at` and `exited_at` NULL, the status bar counts a phantom agent, the card
reads active, and the bottom panel keeps a tab (its tab set is `status === 'running'`,
`derivePanelSessions`).

`isResumeConversationAbsent` (above) removed one trigger. The general case is closed by an
**agent-absence sweep**, a third tier of the bg-shell watcher
(`src/main/activity-engine/background-shell/watcher.ts`). The watcher is already registered for
every spawned session, already holds each session's root PID, and already takes one shared process
snapshot per cycle, so the sweep adds no new subsystem.

**No descendant process means no agent.** That is agent-agnostic, so it needs no adapter
capability and no agent-name branching. Two things make it correct rather than merely plausible:

- **The predicate is any-descendant, not shell-like.** `hasNoNonConsoleDescendants`
  (`process-tree.ts`) deliberately does NOT reuse `filterTopmostShellLikeDescendants`, which exists
  to HIDE the `cmd.exe` shim an agent CLI is often launched through - the opposite of what this
  question needs. Measured live: a real session tree is `pwsh -> cmd.exe -> node`, and the
  shell-like filter would treat that `cmd.exe` as a helper.
- **Console hosts are filtered as defense in depth.** Measured across three live instances, all
  nine ConPTY session shells had their `conhost.exe` parented to the ELECTRON caller (a sibling,
  not a descendant), so a bare shell's descendant set really was empty and a plain emptiness check
  would have sufficed. The filter is kept because console-host parenting is an unspecified Windows
  detail that varies by console host and launch path, and the failure is asymmetric: one stray
  console host would silently disable the sweep for that session forever, while filtering costs
  ~0.3us per cycle for a whole fleet.
- **A false positive is worse than the phantom**, so five guards must all hold: the PTY root itself
  alive (otherwise this is ordinary root death); a HEALTHY probe, reusing the watcher's existing
  discriminator that the snapshot must contain the verified-alive root (an empty or partial
  snapshot means the probe failed, not that nothing is running); two consecutive confirmations;
  past a 30s spawn grace; and the session being a `SessionManager`-approved candidate.

`SessionManager.isAgentAbsenceCandidate` owns every session-shaped arm, so the watcher needs no
session knowledge. It requires a `running`, non-transient session with a live PTY, an agent adapter,
a non-WSL shell, and an elapsed spawn grace. The **transient exclusion is load-bearing**: a Command Terminal is a
bare shell BY DESIGN and is registered with the watcher like any task agent, so without it the sweep
would retire every Command Terminal the moment it opened. A slow-STARTING agent is not excluded by
the grace and does not need to be - its process exists, it just has not drawn yet, which is exactly
why the process tree is a safer signal than a first-output timeout.

The **WSL exclusion covers a different failure than the others**: there the tree signal is
UNREADABLE, not empty. A WSL session's PTY root is `wsl.exe`, and the agent is not a Win32
descendant of it either way - a distro-native CLI is a Linux process in another PID namespace, and
the interop path Kangentic actually uses ([cross-platform.md](cross-platform.md#wsl-runs-the-windows-binary-interop))
launches the Windows binary through WSL's binfmt host rather than under this `wsl.exe`. Since the
Windows probe enumerates `Win32_Process`, a perfectly HEALTHY WSL agent presents an empty descendant
set and passes every other arm, so the sweep would force-kill live work. Refusing to judge it fails
safe to the pre-existing phantom instead. Note this arm is a DENYLIST and closes only the known
case; an allowlist (require that the tree showed a non-console descendant at least once before
absence can be concluded) would close the whole class of structurally invisible subtrees.

**Cadence.** The sweep runs on its own 60s clock (`AGENT_ABSENCE_SWEEP_INTERVAL_MS`), decoupled from
the watcher's 2s/4s/6s poll backoff, and evaluates for free on any cycle that already enumerated for
bg-shell work. `listAllProcesses` is a ~200ms PowerShell CIM query on Windows and the watcher
deliberately skips it on idle cycles, so a per-session-per-cycle check would defeat that
optimization exactly when the machine is saturated. A sweep-only cycle neither increments nor resets
the bg-shell backoff counter. The counter counts consecutive OBSERVATIONS, not poll cycles: a
skipped cycle is neutral, because resetting on skips would mean the count could never reach two.

**What it does.** `SessionManager.retireAgentlessSession` re-checks the guard (the watcher decides
asynchronously) and routes through `kill()`, so the entire existing exit path runs: record marked
exited, queue slot freed, hooks stripped, transcript flushed, and `intentionalExit` suppressing the
renderer's false "Session crashed" toast. Once the tab is gone the leftover shell is unreachable,
so leaving it alive would only leak a process.

**It must also emit `session-changed`, and that emit is load-bearing.** Measured in a live preview:
with `kill()` alone, main and the DB were both correct (`exited`, code 0) while the board kept
counting the agent and the bottom panel kept its tab - the exact two symptoms the sweep exists to
remove. The renderer's `SESSION_EXIT` handler deliberately returns early on an INTENTIONAL exit
(`App.tsx`), because it cannot tell a suspend from a hard end without racing the suspended status
push, so it never runs its own `updateSessionStatus`; and both `derivePanelSessions` and the agent
count read the renderer store, not the DB. `session-changed` (broadcast as `SESSION_STATUS`) carries
a resolved status and has no such ambiguity, so the retirement announces itself there. Pinned by
`tests/unit/session-manager-agent-absence.test.ts`.

The reported exit code is forced to **0** via `ManagedSession.overrideExitCode`, which deliberately
MASKS the OS code. A force-kill reports abnormally on every platform, and `getInterruptedExited`
resumes exactly those on the next launch - so the real code would resurrect the very conversation
the user `/exit`-ed, contradicting that query's "clean exit 0 is excluded". This coupling is pinned
by `tests/unit/session-interrupted-exited-sql.test.ts`, which runs the real query over both designs.

The sweep inherits the watcher's kill switches (`disableBgShellWatcher`,
`KANGENTIC_BG_SHELL_WATCHER=0`, a missing `getSessionRootPid`); with the watcher off there is no
phantom detection, which is accepted since it is the same subsystem. Covered by the `agent-absence
sweep` block in `tests/unit/bg-shell-watcher.test.ts` and by
`tests/unit/session-manager-agent-absence.test.ts`.

### A restore reports progress instead of showing a Resume button

Restoring from Done is slow (the worktree is recreated from the preserved branch, then the CLI
boots) and the task's suspended record survives that whole window, so the UI used to advertise a
manual "Resume session" button while the engine was already restoring the conversation. Two things
now prevent that:

- `TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE` thread `onProgress` into their git helpers exactly as
  `task-move` does, and emit `resuming` immediately so the card is never silent while the lane is
  resolved and the git op queues.
- `getTaskProgress` lets an in-flight spawn label outrank a `suspended` session (only `suspended`;
  a running or queued session owns its own display). An emitted label means main is spawning right
  now, which is newer than a record suspended earlier.

The task therefore shows the `preparing` launch overlay from about 100ms after the drop, through
"Creating worktree..." and "Starting agent...", until the terminal takes over.

When a suspended task moves to an active column:

- Command: `claude --settings <path> --resume <agentSessionId>` (no prompt)
- The resumed id tracks mid-session forks. Running `/clear` inside a Claude session forks the
  conversation to a brand-new session id; the statusline re-reports it and the change-sensitive
  status-file capture (`SessionTelemetry.processStatusUpdate` -> `recoverStaleSessionId`)
  rewrites `sessions.agent_session_id` live. At resume time,
  `reconcileResumeAgentSessionId` (`src/main/transition-engine/resume-id-reconcile.ts`)
  additionally checks the retiring record's own `status.json` and swaps the resumed id if a fork
  landed in the final seconds before suspend (the status watcher detaches before the CLI exits).
  Details and the empirical grounding: docs/adapter-session-history.md, "Mid-session fork
  reconcile".
- New PTY spawned with scrollback carried over from previous session
- New session DB record inserted, old record marked `exited`
- The destination column's settings are re-applied as CLI flags on the resume
  command: `--permission-mode` (lane override, else global default), `--model`,
  and `--effort`. A column move that changes the effective permission mode
  forces this suspend + respawn cycle, because no adapter can switch
  permission mode on a live session.
- A plan-exit auto-move (Planning -> Executing), triggered when the user
  approves the plan (the `ExitPlanMode` tool completes, not when the agent
  merely invokes it), passes a continuation prompt
  ("Proceed with implementing the approved plan.") delivered as the resumed
  session's first message when the destination column has no `auto_command`;
  the `auto_command` wins when present.
- The resume prompt is also how **auto_command escalation** lands. When a live
  session's keystroke injection cannot be confirmed in the agent's transcript,
  `restartSessionForSettingsChange` suspends and resumes with the command as the
  prompt argument, which is guaranteed by the spawn rather than by TUI timing.
  That restart is gated on the turn-completion predicate (activity idle AND a
  quiet PTY) so it can never kill live work, is attempted at most once, and
  carries only the user's `auto_command` - never an adapter-emitted settings
  write, which would arrive as literal message text. Unlike the ordinary
  settings-change restart it does NOT assert idle-authoritative afterwards,
  because a resume with a prompt starts a real turn. See
  [Command Injection](command-injection.md) for the full delivery ladder.
- The **first move OUT of Done** (the recovery / restore move, whatever the
  destination column) resumes the session WITHOUT injecting the destination
  column's `auto_command`. Restoring a Done task is usually to inspect the
  session or ask a question, so the column automation (e.g. `/merge-pull-request`)
  sits idle until the next move. This is unconditional and matches crash
  recovery, which also resumes command-free. Every Done-out path goes through
  `spawnAgent`'s `suppressAutoCommand`: the unarchive handlers
  (`TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE`) set it on their `spawnAgent`
  calls, and a non-archived Done-out move (MCP `move_task`, legacy rows) gets
  it from `handleTaskMove` when `fromLane.role === 'done'`. Model / effort /
  permission-mode settings still apply on the recovery move. The next move
  injects per column config as usual.

## Crash Recovery (Session Recovery)

On project open (`src/main/transition-engine/session-startup/`):

1. **Prune orphaned worktrees** -- delete tasks whose worktree directories were removed externally
2. **Mark crash recovery** -- leftover `running` DB records become `orphaned` (skip records with live PTYs to handle re-entrant calls)
3. **Collect candidates** -- all `suspended` + `orphaned` agent records, plus OS-killed **interrupted-exited** records (any `session_type` except `run_script`). An interrupted-exited record is `status='exited'` with an *abnormal* code (`exit_code != 0`, cross-platform: Windows `1073807364`, Unix `137`/`143`/`130`), a captured `agent_session_id`, that is the latest record for its `(task, session_type, isolation)` group (`getInterruptedExited`). This catches a hard shutdown (OS restart, power loss, SIGKILL) where the PTY died and the onExit handler recorded `exited` before the clean-quit path could mark it `suspended`. Clean exit 0 is excluded so a deliberate `/exit` is never resurrected on startup.

   Exit code 0 no longer means only "the agent ended itself cleanly". The [agent-absence sweep](#a-session-whose-agent-exited-under-a-surviving-shell) also writes 0 when it retires a session whose agent vanished under a live shell, and its trigger set is wider than `/exit`: a CLI crash and a failed launch land there too. So a retirement is never resurrected here, whatever ended the agent. That is deliberate (the alternative resurrects the conversation a user deliberately exited), but note the resulting asymmetry: a crash that KILLS the shell reports an abnormal code and IS recovered, while a crash that leaves the shell alive is reported as 0 and is not.
4. **Deduplicate per `(task_id, isolated_swimlane_id)`** -- keep only the latest record for each parallel session (see [Isolated Sessions](#isolated-sessions-per-column-session-model)), mark older same-session duplicates as `exited`. A task may hold multiple sessions; only same-session duplicates are retired.
5. **Select the current session** -- per task, recover ONLY the session matching the task's current column strategy (`resolveIsolatedSwimlaneId`). Non-target sessions are preserved (an orphaned or interrupted-exited one is CAS-upgraded to `suspended`) so re-entering their column later continues their own conversation.
6. **Filter** -- skip tasks in non-auto-spawn columns (an interrupted-exited record there is CAS-upgraded to `suspended` for future resume, mirroring move-to-Done), skip user-paused sessions (`suspended_by = 'user'`), skip missing CWD, skip deleted/archived tasks. Skipped does NOT mean invisible: a record that ends up `suspended` in a non-auto-spawn **custom** column gets a `registerSuspendedPlaceholder` entry, because the renderer derives the Resume control and the card's click target from its in-memory session list, not the DB. Without one the task presents exactly like a To Do card (click opens the edit form, no Resume anywhere) even though `SESSION_RESUME` would happily resume it. To Do and Done are excluded by ROLE, not by the `auto_spawn` flag: both deliberately hide Resume, and a To Do card relies on having no session so it opens straight into the edit form.
7. **Resume or respawn** (isolation-scoped via `getLatestForTaskByTypeAndIsolation`):
   - Suspended/orphaned/interrupted-exited with `agent_session_id` -- use `--resume` (attempts to restore conversation; the id is first reconciled against the record's own `status.json`, see [Resume](#resume))
   - No session ID -- fresh `--session-id` with prompt from matching `spawn_agent` action
8. **Reconcile** -- spawn fresh agents for tasks in auto_spawn columns with no session at all (skips user-paused tasks); fresh rows are tagged with the column's `isolated_swimlane_id`

## Isolated Sessions (Per-Column Session Model)

A task can run on multiple parallel, independently-resumable sessions. Two orthogonal column fields (set on the Automation tab of the Board Manager) control the behavior; the pure rules live in `src/main/transition-engine/session-isolation.ts`:

- **`session_target`** (`main` | `isolated`, default `main`) - which session track a task runs on. `main` is the task's shared main conversation (resumed as the task moves between normal columns); `isolated` is this column's own separate, context-isolated session, keyed by the swimlane id. Resolved by `resolveSessionTarget` / `resolveIsolatedSwimlaneId`; the discriminator is `sessions.isolated_swimlane_id` (`NULL` = main, swimlane id = isolated).
- **`session_spawn_strategy`** (`create_or_resume` | `always_spawn_new`, default `create_or_resume`) - what to do with that track on entry. `create_or_resume` resumes the track's session if one exists, else spawns it; `always_spawn_new` always spawns fresh, retiring the prior session for that `(task, target)`. Resolved by `resolveForceFresh`, whose default is **context-aware**: an isolated column defaults to `always_spawn_new` (an independent pass each entry), a main column to `create_or_resume` (continuity), unless `session_spawn_strategy` is set explicitly.

The four combinations:

| `session_target` | `session_spawn_strategy` | Behavior |
|---|---|---|
| `main` | `create_or_resume` | Resume the task's main session, or start it (the default) |
| `main` | `always_spawn_new` | Restart the main session from scratch each entry (reset-main) |
| `isolated` | `create_or_resume` | Resume this column's isolated session, or start it (a persistent isolated track) |
| `isolated` | `always_spawn_new` | A fresh, independent pass every entry (the reviewer archetype) |

Both fields are enums so future tracks/strategies need no schema migration.

**An isolated session is context-isolated.** It does NOT inherit the main session's conversation. This is the point of the feature: pairing `session_target: isolated` (with the default `always_spawn_new`) and `auto_command: /code-review` yields an independent reviewer that judges the current diff without the generator's reasoning trail. (This is distinct from Claude Code's own `/fork` / `--fork-session`, which *inherit* the conversation; we deliberately do not.) "Restart the conversation" within a session is otherwise left to the agent's native `/clear` / `/compact`.

**One active PTY per task** is preserved. The worktree is shared across a task's sessions (same `task.worktree_path`), so an isolated session's edits are real and persist; the main session sees the changed tree but not the isolated conversation.

**`always_spawn_new` applies on column entry only.** An app restart / pause-resume of an in-progress session still resumes it (the recovery path is unaffected), so a crash never discards active work.

Lifecycle on task move (`task-move.ts`, the session switch branch inside Priority 3):

- **Enter an isolated column from a live main session**: suspend the main session (preserve `agent_session_id`), then Phase 3 spawns/resumes the isolated session and runs its `auto_command`. With `always_spawn_new` (the isolated default) it spawns fresh each entry, retiring the prior pass.
- **Leave an isolated column for a normal column**: suspend the isolated session (resumable), then Phase 3 resumes the **main** session.
- **Reset-main / recycle**: an `always_spawn_new` column forces a fresh spawn on its target track even when the live session is already on that track, so the switch fires on `resolveForceFresh(toLane)`, not only on a target change.
- The target + spawn policy are derived from the destination column in `resolveSpawnOverrides`, threaded through `SpawnOverrides.isolatedSwimlaneId` / `SpawnOverrides.forceFresh` into `resolveSpawnIntent` (which retires the prior record on a forced-fresh entry) and `sessionRepo.insert`. The terminal tab badges an isolated session as "Isolated" vs "Main".

## Shutdown

On app close, the `before-quit` handler calls `syncShutdownCleanup()`, which is fully synchronous. The `suspendAll()` method exists in `SessionManager` but is **never called during shutdown** -- it is async and would break the synchronous requirement.

The actual shutdown sequence (`syncShutdownCleanup()` in `src/main/index.ts`):

1. Cancel all pending command injections
2. List all in-memory sessions with `running` or `queued` status
3. For each running record, call `captureSessionMetrics()` (synchronous: in-memory cache read + better-sqlite3 writes) so cost / tokens / duration / `tool_breakdown` / `compaction_count` are flushed to the DB before the PTY is killed. The function writes to BOTH the `sessions` row (`SessionRepository.updateMetrics`) and, when `usage` is defined, to a `usage_history` row (`UsageHistoryRepository.recordSessionUsage`) so lifetime period totals survive any subsequent task deletion. Without this step every clean app close loses in-flight metrics for any session that had not yet checkpointed. (The shutdown path uses the synchronous snapshot only; the async transcript-token refinement, `refineTranscriptTokens`, runs only on the exit/suspend/move paths, never here.) A periodic snapshot timer (`startMetricsSnapshotTimer`, ~45s) also runs this same capture for live sessions during normal operation so an app/OS kill bounds the loss to one interval; it is stopped synchronously at the top of `syncShutdownCleanup`.
4. Mark each running record `suspended` (with `suspended_at` timestamp and `suspended_by = 'system'`) so sessions can resume on next launch. Queued records are marked `exited` since there is nothing to resume.
5. Call `SessionManager.killAll()` which force-kills all PTYs immediately (no graceful `/exit`, no waiting)
6. Clean up session files and clear in-memory session maps
7. Delete ephemeral project from index (if applicable)
8. Close all database connections via `closeAll()`
9. Let Electron's normal quit proceed (tears down Chromium child processes)

A hard failsafe timer (`taskkill /T /F` on Windows, 6 seconds) runs as a backstop in case Electron's shutdown hangs.

Sessions are resumable on next launch via `--resume <agent_session_id>` from the saved DB record. The 2-second graceful `/exit` window is intentionally sacrificed to keep shutdown synchronous and prevent zombie processes.

## Terminal Ownership Handoff

- Each PTY session spawns exactly one Claude Code CLI process.
- The bottom panel and the modeless task-detail windows share that process, one xterm per session at a time.
- `dialogSessionIds: string[]` in `SessionStore` lists every session owned by an open task-detail window, in ANY window-manager layer (board, Command Terminal, Agent Monitor). It replaced the scalar `dialogSessionId` once task detail became modeless and windows can stack. It is one array per renderer, so `useWindowSessionClaims` reconciles it across all layers at once.
- When a window claims a session: the panel unmounts that session's xterm instance AND drops its tab, so a detached task leaves no tab that would select an empty pane. The panel keeps every other tab live; it collapses only once no tab is left (`derivePanelSessions` + `shouldForceCollapseTerminal`).
- When the window releases it: the tab returns, still selected, and the panel recreates xterm from the PTY scrollback buffer.
- This prevents duplicate xterm instances from sending conflicting resize calls.
- Both surfaces can therefore hold a live terminal at once, so `deriveFocusedSessionIds` focuses the window-owned sessions AND the panel's own session; anything with a mounted xterm must be in that set or the main process suppresses its PTY output.
- **Which of those terminals takes KEYBOARD focus when it arrives is arbitrated, not raced**
  (`src/renderer/utils/terminal-arrival-focus.ts`). The handoff above is exactly what creates the
  race: opening a detail claims its session, so the panel drops that tab and mounts a terminal for a
  DIFFERENT session at the same moment the window mounts its own. Both then fetch scrollback, which
  main delays 150-400ms for the repaint settle, and every arrival path used to end in an
  unconditional `xterm.focus()` - so whichever replay resolved LAST won, and a user who opened a
  task and started typing could have the keystrokes land in whatever agent the panel fell back to.
  `mayTakeArrivalFocus(sessionId)` decides from user-intent STATE instead, in three tiers:
  a claim recorded by a gesture that named a terminal before it existed (a panel tab click, a panel
  expand - the panel is not a window, so neither moves any layer's `focusedWindowId`); else the
  terminal-hosting window holding window-layer focus, resolved by ANCHOR across all three layers
  via `resolveFocusedWindowTerminal` in `dictation-target.ts`; else, when nothing owns the user's
  attention, allow unless focus is in a typing surface. A claim is NOT consumed on grant, because
  one arrival legitimately fires focus more than once (the deferred-init frame, then the mount
  replay); a later window-focus change (the fingerprint) or the TTL is what ends it. Tiers 1 and 2
  DENY a mismatch outright rather than falling through, which is what stops two terminals arriving
  in one frame from both being permitted - including the case where the focused window has not
  spawned a session yet, which still blocks everyone else. Tier 3 has no mismatch to deny, so its
  own guard is a 500ms burst hold (`ARRIVAL_BURST_MS`): several terminals can reach it together on a
  workspace restore that persisted no focused window, and only the first wins. Hosts own the policy
  and pass it to `useTerminal` as an option, so the hook stays
  surface-agnostic. Genuinely user-initiated focus (frame pointer-down, file drop, maximize
  re-homing) is unconditional and marked `// arrival-focus-ok:`. See
  `.claude/rules/terminal-arrival-focus.md`.
- The converse also holds: anything with NO mounted xterm must be OUT of that set. A collapsed panel renders no `TerminalTab`, so `derivePanelSessionId` returns null for it (`panelShowsTerminal`, threaded from `useTerminalResize`'s `showContent`). Otherwise main streams bytes nothing can acknowledge, and a chatty agent eventually trips backpressure (`BACKPRESSURE_HIGH_WATER`) and has its PTY paused. Output produced while collapsed accumulates in main's scrollback ring and is replayed when the panel expands and the terminal remounts. A remount is not the only way back: a session that stays MOUNTED and merely leaves the focused union (a detail window a detached monitor owns, a hidden panel, a closed command bar over a transient) is repaired on the focus edge alone, without remounting. See the focus-edge catch-up bullet under Output Streaming.

## Project-Scoped Session State

Sessions from non-active projects must not interfere with the active project's terminal panel, activity icons, or store state. This is enforced at three levels:

1. **IPC event forwarding** -- All session events (`data`, `usage`, `activity`, `event`, `status`, `exit`) include the session's `projectId`. The renderer filters events by comparing against the current project.
2. **Cache getters** -- `getUsage`, `getActivity`, and `getEventsCache` accept an optional `projectId` parameter. When provided, `SessionManager` returns only data for sessions belonging to that project.
3. **Store scoping** -- `syncSessions()` fetches usage and events scoped to the current project, but activity unscoped (sidebar badges need cross-project data). On project switch, `activeSessionId`, `dialogSessionIds`, `openTaskId`, `sessionUsage`, and `sessionEvents` are cleared; `sessions` and `sessionActivity` are preserved for the sidebar. A generation counter invalidates any in-flight `syncSessions()` calls from the previous project, and a snapshot-based merge preserves IPC-delivered status updates that arrive during the async gap.

**Sidebar exception:** Activity state (`thinking`/`idle`) is always forwarded and stored regardless of project, so the sidebar can show badge counts for all projects. Auto-focus and sync triggers are gated to the current project only.

## Transcript Capture

PTY output is captured for two purposes: terminal display (via the scrollback buffer) and persistent transcript storage (via `TranscriptWriter`).

`TranscriptWriter` (`src/main/pty/buffer/transcript-writer.ts`) receives raw PTY data, strips ANSI escape sequences, and debounces writes to the `session_transcripts` table every 30 seconds, flushing early if a session's pending buffer exceeds 256KB. This provides a clean, searchable text transcript of the session without terminal formatting noise.

The transcript is used during cross-agent handoff: when a task moves to a column with a different agent, the `HandoffOrchestrator` reads the transcript from the database, combines it with git diff and session metrics, and packages it as handoff context for the new agent.

## Cross-Agent Handoff

When a task moves to a column where `resolveTargetAgent()` returns a different agent than the current session:

1. The current session is suspended (Priority 3a in the [Transition Engine](transition-engine.md))
2. The `HandoffOrchestrator` packages context: session transcript (from `session_transcripts`), git diff (changed files), and session metrics (tokens, cost, duration)
3. A new session is spawned with the target agent, receiving a `handoffPromptPrefix` summarizing the previous agent's work
4. A `handoff-context.md` file is written to the new session directory for reference
5. A `handoffs` record is inserted in the database tracking the from/to agents, sessions, and the full context packet

The handoff is transparent to the user - the task card shows spawn progress phases (`packaging-handoff`, `detecting-agent`, `starting-agent`) and the shimmer overlay lifts when the new agent's TUI is ready.

## Output Streaming

- PTY `onData` accumulates into a per-session buffer.
- A 16ms flush interval (~60fps) emits buffered data via IPC `session:data`.
- A 512KB scrollback ring buffer per session supports terminal restoration.
- **Alt-screen sessions replay the parsed grid, not the byte tail.** A raw byte replay is not a
  frame snapshot: a fullscreen TUI leaves write-once static cells (box rules, mode labels)
  undrawn after a clear, so once a session outgrows the 512KB ring their drawing bytes are gone
  and a remount at unchanged geometry (no SIGWINCH, so no fresh repaint) paints a permanently
  holed frame. `PtyBufferManager.getReplaySnapshot` therefore serves the headless PARSED grid
  (the same serialized frame `getSerializedFrame` gives the mobile seed) when the session is in
  the alt screen, and the raw byte replay otherwise - a plain shell's scrollback IS the bytes,
  and truncation there only loses old history.
- **Do not trim the byte replay to the last full-screen clear.** Tried and reverted: it cut a
  512KB ring to ~1.5KB but produced a permanently black terminal on a fast open/close/reopen.
  Slicing at the last clear discards write-once cells, and a sample landing at or just after a
  clear replays a clear with nothing after it. The parsed-grid snapshot above is the safe shape,
  not a byte-offset heuristic; and since the byte path now serves normal-buffer sessions, a trim
  there would discard genuine user-scrollable history, not just a TUI's redraw bytes.
- **One grid width per mount (deterministic fit).** `describeProposedDimensions`
  (`src/renderer/addons/fit-addon.ts`, the single implementation that both `proposeDimensions` and
  `fit` read) is a pure function of two inputs and no others: the container geometry, and the ACTIVE
  renderer's cell metric. It must not read anything else that can change while a terminal is
  mounting, because every distinct column count costs a PTY resize and a full agent
  repaint the user watches land. Holding the second input still across a mount or a reveal is the
  next bullet's subject. The rule exists because the fit used to reclaim the scrollbar
  gutter whenever the alternate screen buffer was active: the scrollback replay writes the TUI's
  alt-screen enter mid-mount, so the mount fit and the post-replay refit disagreed by two columns on
  every open (always, under Claude Code's `/tui fullscreen`). That produced the "opens mis-sized,
  then refits" flash, and its stacked-repaint race intermittently left the terminal black with
  correct dimensions. xterm's own stylesheet sets `.xterm-viewport { overflow-y: scroll }`, so the
  gutter is reserved in the alt buffer too; it is now MEASURED (`offsetWidth - clientWidth`) rather
  than assumed, which is both correct and constant across buffer modes. The old hardcoded 14px
  against the real 8px gutter was the actual cause of the empty right-hand strip that the
  alt-buffer reclaim was mistakenly written to fix. Gated by
  `tests/e2e/terminal-fit-invariant.spec.ts` (one distinct grid width per open, and the grid never
  wider than its viewport) and `tests/unit/fit-addon.test.ts`.
- **Fit only on the renderer the terminal keeps.** The container is not the fit's only input: the
  cell metric is, and that comes from whichever renderer is attached
  (`_renderService.dimensions.css.cell.width`). Parking a terminal disposes its WebGL addon for the
  GPU budget, and the DOM renderer it falls back to measures a WIDER cell, so an unchanged container
  proposes ~10% FEWER columns while suspended (measured: 210 attached, 191 suspended, at
  hostWidth 1483). `useFocusedSessionsSync` therefore applies the WebGL attachment plan BEFORE it
  publishes the parked set, because `syncParkedTerminals` fires reveal listeners synchronously and
  each one fits itself on the spot; the mount path already had this order
  (`attachWebglRenderer`, then the initial fit). With the order inverted, a Board -> Backlog ->
  Board round trip wrote main's full-width frame into the narrow grid and the refit widened it back
  WITHOUT reflowing - xterm reflows the normal buffer on resize and never the alternate one, so a
  full-screen agent TUI stayed hard-wrapped until something forced a repaint. As a backstop for
  the other ways the width can move across a REVEAL replay's async gap, `resolveReplayWidthAction`
  (`useTerminal.ts`) compares the grid width at the write against the width after the post-write
  refit and re-issues the replay once on a mismatch. It is wired into `reloadScrollback` only. The
  mount replay has the same structural gap but is usually not exposed to it: its fit runs after the
  WebGL attach, and it sends a real resize, so main serializes at the width it fitted to. The
  exception is a mount taken while the page is already at `WEBGL_ATTACH_BUDGET` - that terminal
  starts SUSPENDED, so its fit reads the DOM cell, and the coordinator's next plan can promote it to
  WebGL mid-replay, which is the same uncovered corruption. Widening the backstop to the mount path
  is left undone deliberately. `fit()` returns an applied/declined outcome so
  a silent bail (a collapsed container, an unmeasured cell) is distinguishable from a real resize in
  the `fit` trace. Gated by `tests/unit/replay-width-invariant.test.ts` and
  `tests/ui/window-reveal-grid-width.spec.ts`, which deliberately keeps WebGL on and asserts on the
  renderer trace ring, because the specs that read terminal CONTENT pass `--disable-webgl` and so
  cannot reproduce a renderer swap at all.
- **A session nobody is showing goes back to the spawn grid (the resting grid).** A PTY has ONE
  grid and every surface fits it to its own box, so a session last shown in the bottom panel was
  left at that panel's strip - measured live at 306x14 - with nothing to give it back. The agent
  then kept working in a 14-row window, and a paired phone (which mirrors the desktop grid 1:1 and
  cannot reshape a shared session) could not fill its screen from 14 rows no matter what it did
  locally. `SessionManager.scheduleRestingGridRestore` parks such a session at the RESTING GRID
  (`RESTING_GRID_COLS x RESTING_GRID_ROWS`, 210x48 - detail-shaped on purpose, not the 120x30
  spawn default: the phone mirrors the resting grid 1:1, and a phone-fitted narrow grid was
  built, live-tested, and judged LESS readable than the desktop's own layout, whose rules and
  boxes are drawn for a wide frame) after `RESTING_GRID_DELAY_MS` (1s). The park is a MOBILE
  feature and is gated on mobile interest: it fires only for a session a paired phone is actually
  streaming (`MobileTerminalProbe.hasStreamSubscriber`, answered from the bridge's per-device
  subscription registries), and a phone subscribing to a session that went unheld earlier gets an
  immediate park instead (`parkRestingGridForMobileSubscriber`, called by the read-stream
  subscribe handler BEFORE it serializes the seed, so the one snapshot already carries the
  resting grid). A desktop that never pairs never parks at all - no probe, no bridge registries,
  byte-for-byte the pre-park behavior. Three further guards make a firing park safe: it fires
  only when NOTHING holds the session - unfocused AND no renderer has an xterm mounted for it
  (`session:setMounted`, published by `terminal-mount-registry` from each terminal's own mount
  effect); it never touches a grid a phone is holding (the armed size guard consulted through
  `MobileTerminalProbe.isSizeHeld` - the guard registry, never a last-writer origin, which a
  desktop resize overwrites while the hold stays armed); and it no-ops when the PTY is already at
  the spawn grid. The park resizes with origin `'park'`, which deliberately does NOT update
  `lastDesktopDimensions`: that map is the restore target for a phone's `release-size`, and a
  park recording itself there made release "restore" the phone straight back to 120x30. After a
  release the guard teardown asks for the park decision to re-run
  (`reconsiderRestingGridAfterMobileRelease`), so an unheld session returns to the resting grid
  and the phone's next visit finds park dims again. The mounted set is the load-bearing hold: a
  PARKED terminal (Backlog view, occluded window) is unfocused but still mounted, and xterm
  re-sends dimensions only when its OWN size changes, so a PTY reshaped underneath one would
  disagree with it permanently - and the reveal deliberately skips its resize. Cost when it does
  fire: the next open of that session pays the marker settle (~20-40ms) because the grid changed
  while it was away, which is what any surface switch already pays. Gated by the `Resting grid
  restore` block in `tests/unit/session-manager.test.ts`,
  `tests/unit/terminal-mount-registry.test.ts`, and the park assertions in
  `tests/unit/mobile-bridge/{interactive-terminal,read-stream}.test.ts`.
- **A phone-streamed session is never rendered by the bottom panel, and never drops below the
  mobile row floor.** Terminal ownership is one xterm per PTY, and a phone mirrors the grid 1:1
  with no way to escape a strip-shaped fit: when the expanded bottom panel survived a
  detail-close as the owning surface, its fit took the grid to the 306x14 strip and the phone
  showed a sliver; and when the park reshaped a session under an unmounted-then-revealed panel
  xterm, the reveal's `skipResize` replay left the panel permanently mis-wrapped (both observed
  live 2026-08-02; user decision: the panel is a utility surface - the task detail is primary,
  and the phone must never inherit the strip). Three layers enforce it:
  1. **The gate is terminal-wanting subscriptions, not the bare stream key.** The phone holds a
     list-only stream subscription for EVERY live session whenever it is connected, so
     `MobileTerminalProbe.hasStreamSubscriber` answers from the `stream-terminal:<id>` marker
     that `read-stream` registers only for `terminal: true` subscribes (and removes on every
     release path). Gating on `stream:<id>` made the park fire for the entire board.
  2. **The panel drops the tab of a phone-streamed session entirely.** Main pushes the
     terminal-streamed set to the renderer (`MobileBridgeService.terminalStreamedSessionIds`,
     `mobile:terminalStreamsChanged`, mirrored by `useMobileTerminalStreamsSync`), and
     `derivePanelSessions` folds it into the `owned` exclusion - the same no-tab treatment a
     detail-owned session gets, so no panel fit ever contends with the park, and the focused
     set, the parked/reveal plan, and the WebGL budget all follow from the shared derivation.
     No placeholder (user decision 2026-08-02): the user watching that session is on their
     phone, not at the desk, and the tab returns the moment the phone lets go. A task-detail
     window still mounts a real terminal: the detail is primary and its grid wins while open.
  3. **`SessionManager` backstops the races** (`MOBILE_USABLE_MIN_ROWS`, 20): `resize()`
     REFUSES a desktop-origin resize below the floor while a phone streams (before
     `bufferManager.onResize`, so the headless parser never diverges from the real PTY; the
     refused grid still records `lastDesktopDimensions` as the restore target), and
     `parkRestingGridForMobileSubscriber` overrides a desktop HOLD below the floor, rescuing a
     phone that subscribes to a session the strip captured before the phone arrived.
  A desktop with no terminal-streaming phone never hits any layer: the panel renders and owns
  grids exactly as before the park existed. Gated by the floor tests in the `Resting grid
  restore` block of `tests/unit/session-manager.test.ts`, the terminal-marker tests in
  `tests/unit/mobile-bridge/read-stream.test.ts`, the change-hook test in
  `tests/unit/mobile-bridge/subscription-registry.test.ts`, and `panelTerminalSessionIdFor` in
  `tests/unit/focused-sessions.test.ts`.
- **The width-drift self-heal (PTY dims echo + owner re-assert).** xterm re-sends its dimensions
  only when its OWN size changes, so a PTY reshaped under a mounted xterm (a lost or overridden
  resize on a surface flip, a respawn at stashed dims, any last-writer-wins race - `resize()`
  carries no surface identity) used to diverge with NO recovery path: with the Windows
  full-repaint flag every frame is absolute-positioned at the PTY width, so the mounted grid
  rendered a staircase (rows shifted progressively right, labels clipped) until the window was
  resized by hand. Main now broadcasts `session:ptyResized` (`SESSION_PTY_RESIZED`) whenever the
  PTY's grid ACTUALLY changes - the same-dims short-circuit runs first, so the echo of a
  terminal's own resize always carries its own dims - with the resize's origin
  (`PtyResizeOrigin`: `desktop`/`mobile`/`park`/`spawn`). It is a broadcast, not a focus-routed
  push: a freshly mounted xterm can miss a routed echo during exactly the mount window where a
  divergence is born, and echoes only fire on real grid changes. The mounted owner's listener
  (`useTerminal`) compares the echoed dims to its own and, when they disagree, re-asserts its
  fitted grid after a 150ms coalescing debounce and repairs the already-garbled frame with a
  `reloadScrollback({ skipResize: true })` replay (the resize it just sent armed the repaint
  settle, so the reload samples the frame drawn at the corrected width). The guard matrix is the
  pure `resolvePtyEchoReassert` (exported from `useTerminal.ts`): in-sync self-filter first,
  then foreign-hold (`mobile`/`park` origins - a phone or the park legitimately holds the grid;
  `spawn` is healable), refused-hold (see below), parked, replay-in-flight, own-resize-pending,
  and last a TIME-WINDOWED budget (2 re-asserts per divergence signature per 10s) - deliberately
  not reset by an in-sync echo, because in a two-surface fight each side's successful re-assert
  lands an in-sync echo at the other side, so a reset-on-heal budget never binds in exactly the
  livelock it exists to bound. `resize()` also reports `refused: true` from the mobile sub-floor
  branch (the one path where main deliberately holds the grid against the caller), which arms a
  time-stamped refusal hold after a single refused IPC: no further re-asserts for the budget
  window, whatever dims later echoes carry (time-stamped rather than signature-keyed, because
  the pre-send fit can move the terminal's own dims and a burned signature would stop binding
  exactly then). Every renderer resize sender now traces `resize-request` with an origin
  tag (`mount`/`flush`/`reload`/`echo-reassert`/`debounced-onResize`) and main traces every
  resize outcome (`resize-applied`/`resize-noop`/`resize-refused`/`resize-stash`/
  `resize-ignored`/`resize-invalid`), so `kangentic_devtools_terminal_state`'s merged trace
  names the trigger if a divergence ever recurs. A resize for a queued or suspended session
  stashes (including suspend's marked-but-alive teardown window, where the PTY is still
  non-null but must not be reshaped or re-echoed); one for a missing or exited session is
  ignored. Gated by `tests/unit/pty-resize-echo-reassert.test.ts` (the guard
  matrix), the emit/refusal pins in `tests/unit/session-manager.test.ts`,
  `tests/ui/terminal-resize-echo-reassert.spec.ts` (real xterm wiring: re-assert, repair,
  self-echo no-op, budget bound), and `tests/e2e/terminal-width-drift-selfheal.spec.ts` (a real
  PTY driven to the incident by a rogue `sessions.resize`, healed back to the owner grid).
- **Repaint-settled scrollback sampling.** A session spawns at a default 120x30; on a cold launch
  an auto-resumed PTY sits at that size until a card opens and the renderer fits it wider. When a
  geometry-changing resize fires (cols OR rows), a full-screen agent TUI repaints its frame
  asynchronously in response to SIGWINCH. So `getScrollback` waits for that repaint to land and
  quiesce before sampling (`PtyBufferManager.waitForResizeRepaint`), so a terminal restored right
  after a resize replays the frame at the fitted geometry instead of a stale one. Width armed the
  settle first; rows-only changes (a bottom-panel height drag, a vertical-only window resize) arm
  it too since a 2026-07-31 live measurement: 12/12 trials sampled the old-row-count frame before
  the repaint, and the rows repaint always arrived 21-122ms later carrying a full `\x1b[2J` erase,
  so the marker settles the wait early rather than riding the ceiling. (The resize IPC's
  `colsChanged` report is unchanged - arming widened internally; nothing on the renderer or the
  mobile wire consumes a rows flag.) A ring with NO `\x1b[2J` anywhere takes a
  short wait of its own rather than the old instant sample: "no marker" at mount time also
  describes a fullscreen TUI that has not drawn its first frame yet (observed live as a 237-byte
  replay where a settled mount replays hundreds of KB), so the no-marker path samples on a
  post-resize erase (the first frame just landed), on a marker-less quiesce, or - for a session
  that answers SIGWINCH with silence, i.e. a plain shell - after a small grace
  (`NO_MARKER_SILENT_GRACE_MS`), bounded by `NO_MARKER_MAX_WAIT_MS` far below the TUI ceiling so
  Command Terminal opens stay fast. The wait is skipped entirely when the session has no live PTY
  (a suspended, killed, or pre-spawn session can never receive a SIGWINCH repaint, so the wait
  would only burn its deadline), and is bounded by a max-wait ceiling, so a missing or
  slow repaint can only delay a first paint, never hang the read. An actively streaming session
  never quiesces, so the wait also settles EARLY the moment a full-frame repaint marker lands in
  the bytes appended after the resize, outside any open synchronized-output frame - instead of
  burning the whole ceiling and sampling mid-repaint. The marker is the `\x1b[2J` erase ONLY: a
  bare `\x1b[H` cursor-home was tried and reverted, since TUIs emit it for ordinary partial
  updates (a live session showed 169 cursor-homes to 56 erases). STACKED resizes (a second
  geometry change while a RECENT previous repaint is still pending, e.g. rapidly closing and
  reopening a task detail ping-pongs the PTY between the dialog and bottom-panel widths) disable
  the marker-only settle - the first marker may be the previous geometry's late repaint - and
  require marker AND quiesce, falling back to the ceiling while streaming. An arm older than the
  400ms ceiling does not stack the next one: by then its repaint has landed or never will (the
  settle itself stops waiting at that ceiling), so an unconsumed old arm - a height drag nothing
  sampled after - cannot slow the next open. Concurrent samplers of the SAME
  resize (a bottom-panel tab and a detail window overlapping during a handover; in dev, StrictMode's
  double mount of a Command Terminal window - both terminal hosts defer their init off the mount
  commit via the shared `useDeferredTerminalInit` hook, which lets StrictMode's
  synchronous unmount cancel the first scheduled init, so each pair collapses to a single fetch
  and no throwaway xterm races the survivor; what matters here is cancel-before-run, not which
  frame the init lands on, since the shared queue in `terminal-init-queue.ts` can push a host
  contending with others several frames out) share ONE wait: the second joins the first rather
  than starting its own. Two
  independent waits could not both work, because the first to settle clears the pending-repaint
  state that the other's early-settle scan offset points at, so the loser could never settle early
  and rode the full ceiling out - a deterministic ~415ms added to that open. A resize that arrives
  before the PTY exists (the renderer mounts before the auto-resume spawn lands) is stashed and
  applied at spawn, so the PTY starts at the fitted size and no corrective resize is needed.
  One reader deliberately OPTS OUT of this settle: `SessionManager.getOutputPeek`, which backs the
  Agent Monitor's live output peek. The settle exists so a captured frame becomes the terminal the
  user then looks at; a peek is a few throwaway lines resampled twice a second, so a mid-repaint
  sample self-corrects on the next tick, while awaiting the settle would cost up to the ceiling on
  every sample and force a synchronous read to become async. It reads the parsed grid row by row
  (`HeadlessFrameBuffer.cursorRow` / `lineAt`) rather than serializing a frame, and the line
  selection lives in `src/main/pty/buffer/output-peek.ts`.
- **DEC private mode and alt-screen re-assert on replay.** `xterm.reset()` on the renderer wipes
  every DEC private mode xterm is tracking, and the original mode-set bytes usually scroll out of
  the 512KB scrollback window on a long-running session. On the byte-replay path,
  `PtyBufferManager` tracks DEC private input/reporting modes (DECCKM, mouse tracking, bracketed
  paste, ...) from the live stream and re-asserts them as a prefix on `getScrollback` (#313), and
  a synchronized-output frame (mode 2026) left open by a mid-frame sample is closed with a
  trailing `\x1b[?2026l` so it cannot stall the renderer's ~1s safety timeout. Alt-screen (mode
  1049/47/1047) is tracked separately as `inAltScreen`; it routes the replay (see
  `getReplaySnapshot` above), and a session in the alt screen gets a serialized frame that carries
  its own addon-emitted alt-screen switch and mode re-asserts (mid-stream, after the serialized
  normal buffer - not a leading prefix, so nothing may `startsWith` on it), so the replay paints
  into the alt buffer with the right input modes (a replay landing in the normal buffer was
  previously the cause of a cursor left visually disconnected from the TUI frame). One mode class
  the addon cannot emit is the mouse ENCODING modes (1005/1006/1015/1016 - it re-asserts mouse
  TRACKING only), so `getReplaySnapshot` folds the tracked DEC-mode prefix onto the frame; without
  it, a same-grid remount left xterm reporting legacy X10 mouse bytes that an SGR-expecting TUI
  ignores, and wheel scroll went dead until the TUI happened to re-assert its own modes.
  A SECOND thing the addon cannot emit is the DECSTBM scroll region: it builds its prefix from
  `terminal.modes`, and a region is two integers of buffer state rather than a mode flag, so
  `IModes` has no member for it. `HeadlessFrameBuffer.serialize` therefore appends the region
  itself plus an absolute cursor restore. Order is load-bearing twice over: the region must FOLLOW
  the frame (set before it, the frame's own row writes would scroll against it), and it must be
  followed by the CUP, because DECSTBM homes the cursor and would otherwise discard the position
  the addon's relative moves just rebuilt. The suffix is empty only when the region already spans
  the grid AND origin mode is off, which is the common case: with DECOM on it still emits a bare
  CUP, because the addon appends its own `\x1b[?6h` after its cursor restore and DECSET 6 homes
  the cursor too. Claude Code gates its own DECSTBM use on a terminal-capability probe and
  currently leaves it off under xterm.js (measured with `claude --debug`: `XTVERSION: no reply`
  then `DECSTBM: gated`, because xterm registers `CSI > c` but no `CSI > q`), so the REGION half
  guards against that gate reopening rather than repairing a live break. The origin-mode half
  repairs a live one.
  `getScrollback` itself retains the `\x1b[?1049h` prefix gate, reachable now only via direct
  byte-path reads and `getReplaySnapshot`'s serialize-deadline fallback.
- **Hold, not drop, live output across a renderer-side replay.** While a scrollback replay is in
  flight (`scrollbackPendingRef`), the renderer's incoming-write queue HOLDS (retains, does not
  ack) rather than drops live PTY bytes, and flushes them in order once the replay's `afterWrite`
  completes. This closes a window where a live diff (e.g. a fullscreen TUI's selection-highlight
  redraw) could be silently discarded during a reattach. Only the loading overlay continues to
  drop-and-ack (its window can span the whole agent startup). A generation-aware `afterWrite` and a
  bounded watchdog timer additionally guard against a stale or stuck replay leaving
  `scrollbackPendingRef` true indefinitely, which would otherwise drop all live output forever.
- **But the held bytes that PREDATE the sample are dropped, not flushed.** The hold above must not
  be read as "every held byte is flushed after the replay": bytes main flushed BEFORE the
  `getScrollback` reply are, by construction, already inside the replay whichever shape it takes
  (a byte replay: main appends to its ring and its pending buffer from the same bytes and clears
  the pending buffer when it samples; a parsed-grid frame: the serialize is atomic with the
  parser's flush barrier so every pre-sample byte is baked in, bytes racing the sample ride the
  reply as an appended tail, and main holds the session's flush ticks for the sample's duration
  so nothing can be flushed ahead of the reply), so
  flushing them afterwards repaints a pre-sample frame ON TOP of the fresh one. Because a TUI then
  sends only differential updates, nothing repairs it and the terminal shows the previous geometry's
  frame until the next SIGWINCH - a task detail opening on a session at the bottom panel's 14 rows
  showed that 14-row frame in a 48-row grid until the window was resized by hand. Both replay paths
  therefore reset the queue the moment the sample resolves, before writing it, and trace what they
  discarded (`replay-drop-held`, with a byte count). Bytes flushed AFTER the reply are post-sample
  and still held, then flushed, exactly as above. This was latent until the deferred terminal init
  collapsed `TerminalTab`'s StrictMode double mount to one terminal: the second mount's replay had
  been overwriting the stale paint.
- **A replay never leaves the terminal both blank and held.** Two rules keep an aborted replay from
  becoming a permanently black terminal. First, `reloadScrollback` clears the terminal immediately
  before writing the new frame, not before fetching it: clearing first opened a window in which only
  a SUCCESSFUL replay ever repainted, so any abort (a newer generation, a rejected read) left the
  grid empty with every byte still sitting in the main-process ring and an idle agent with no reason
  to send more. The last good frame now stays on screen until the new one replaces it. Second, the
  stuck-replay watchdog RECOVERS (re-issues the replay once, at the already-synced width) rather
  than only unblocking the queue, since unblocking a queue does not repaint a cleared grid. The
  replay lifecycle is traced (`replay-start` / `-write` / `-abort` / `-done` / `-error` /
  `-watchdog`, each with its generation) and surfaces in `kangentic_devtools_terminal_state`, so an
  abandoned replay is readable directly instead of inferred from a missing later event.
- **Focus-edge catch-up, the wider sibling of park/reveal.** Main gates PTY emission on its focused
  union, but the only catch-up repaint used to be `onTerminalReveal`, which fires on the PARKED
  edge. Parking implies unfocus, not the reverse, so every session that left the union WITHOUT
  being parked had no path back to a correct grid: a detail window a detached monitor owns
  (`remotelyOwnedSessionIds`), a hidden bottom panel, a closed command bar over a transient.
  `src/renderer/utils/focused-terminals.ts` adds the missing edge (`syncFocusedTerminals` /
  `onTerminalRefocus`, edge-triggered exactly like the parked registry), and `useTerminal`
  subscribes it to the same `reloadScrollback({ skipResize: true, skipFocus: true })` the reveal
  path uses, skipping when a replay is already in flight so a mount-time replay is never aborted
  and re-issued for the same frame. Both registries are kept: only parking additionally makes the
  incoming queue ack-and-discard, so neither subsumes the other.
- **Mouse reports are paced, never batched.** Outgoing terminal input rides a microtask write
  batcher (`src/renderer/utils/write-batcher.ts`) that coalesces synchronous onData bursts into
  one IPC write - byte-safe, but not semantics-safe for a fullscreen TUI, which treats a chunk
  as one input batch: a run of wheel reports delivered together becomes one multi-line jump, and
  the TUI's differential frame for a multi-line jump intermittently mis-assembles (the
  missing-entries family below). Verified by controlled injection (2026-08-23): ten spaced
  reports produced ten clean frames and ~29KB of output; the same ten in one chunk produced one
  ~2KB spliced frame. Unbatching alone is NOT enough - a pipe preserves no message boundaries,
  so reports written back-to-back still land in one read while the TUI renders the previous
  frame. So `useTerminal` routes every mouse report (`isMouseReport`) through `writePaced`: an
  ordered queue that writes each report as its own payload at a 16ms-per-report floor, restoring
  the physical-wheel cadence a native terminal delivers; typed bytes keep arrival order across
  the two paths, and teardown drops pending reports rather than writing them joined.
  (Ack-clocking each report to the TUI's answer was tried and reverted: the TUI coalesces
  repaints onto its own frame clock, so input-clocking capped scrolling at ~10Hz.) The jump a
  coalesced read still produces is bounded by keeping `CLAUDE_CODE_SCROLL_SPEED` at the CLI
  default of 1 - see [docs/cross-platform.md](cross-platform.md) for why Kangentic no longer
  raises it. This targets the wheel-scroll flavor at the source; single-report multi-line jumps
  the CLI performs internally (Ctrl+End, PageUp/Down) remain exposed and are what the repaint
  nudge below repairs.
- **Post-interaction repaint nudge.** A fullscreen TUI intermittently emits a frame that erases
  the grid and then redraws only some of it, leaving either the whole transcript blank or a
  contiguous band of rows missing mid-frame. Its renderer is differential, so it never revisits
  those rows and only a full repaint heals them, which is why a click or a resize fixes it and
  waiting does not. `src/renderer/utils/repaint-nudge.ts` asks for that repaint automatically:
  after real user input reaches a focused alt-screen terminal and the output it provoked goes
  quiet (250ms), it writes a FocusOut+FocusIn pair, which is the same report a real terminal sends
  on alt-tab and the same one the user's click was already sending. It fires on the TRIGGER rather
  than on a detected symptom, so there is no threshold to false-positive on a legitimately sparse
  frame and it covers every shape of the defect. Gated on alt-screen plus DECSET 1004 plus
  not-parked plus no-replay-pending, floored at one per 750ms per session. `isUserInputData`
  filters out xterm's OWN focus and motion reports, which arrive through the same `onData` channel
  and would otherwise self-arm a nudge on every mount replay. The before/after grid comparison is
  reporting only and never gates the nudge. A richer repair layer (resize and replay arming
  channels, a spaced focus pair, mid-burst fires, floor deferral, a persisted verdict log) was
  built, dogfooded, and removed the same day: against a producer-side defect it bought visible
  repair flicker, not correctness. Upstream: anthropics/claude-code#83714 - reproduced NATIVELY
  (PowerShell, wheel-scrolling deep into a large resumed session), so this whole family is the
  CLI renderer's, not the host's. Every host-side workaround site carries an
  `UNWIND(claude-code#83714)` marker; grep for it and sweep them out when upstream fixes the
  renderer.
- **Trace vocabulary for the two mechanisms above.** `focus-union-gained` / `focus-union-lost`
  (main, `recomputeFocusedUnion`), `terminal-unfocus` / `terminal-refocus` (renderer,
  `focused-terminals.ts`), and `repaint-repaired` / `repaint-verified` (renderer,
  `repaint-nudge.ts`, the latter meaning the frame was already correct and the nudge cost one
  render). `arrival-focus` (renderer, `terminal-arrival-focus.ts`) joins them, carrying the
  allow/deny plus the tier that decided it (`claim` / `claim-mismatch` / `window` /
  `window-mismatch` / `occupied` / `burst-taken` / `unclaimed`) - the only record of WHY a terminal
  did or did not take focus, which a "typed into the wrong terminal" report otherwise leaves to
  guesswork. All seven merge into `kangentic_devtools_terminal_state`'s timeline alongside the
  resize and replay events above. `kangentic_devtools_terminal_forensics` is the session-scoped
  companion: renderer viewport rows, main's re-parsed grid, and the raw byte ring side by side,
  which is what separates "the agent never sent these rows" from "we lost them".
- **Replay veil for a warm mount.** For an already-running session, `TerminalTab`'s launch overlay
  never shows (`terminalReady` starts true), so the whole mount-time fit -> replay -> refit ->
  held-byte-flush sequence used to paint live, occasionally as a visible flash. `TerminalTab` now
  covers the terminal with a veil (fixed terminal-background color, no spinner or transition) from
  mount until `useTerminal` fires its first `onScrollbackSettled` notification, so only the settled
  frame is ever shown. Every settle path (afterWrite, IPC-rejection catch, watchdog) funnels
  through one `settleScrollback` chokepoint, so the veil always lifts.

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| MAX_SCROLLBACK | 512 KB | Terminal history per session |
| MAX_EVENTS | 500 | Activity log cap per session |
| Flush interval | 16 ms | Output batching (~60fps) |
| Repaint-settle max wait | 400 ms | Ceiling for the post-resize repaint wait before sampling scrollback |
| Status debounce | 100 ms | Usage file watch |
| Event debounce | 50 ms | Event log + activity state watch |
| Hard shutdown deadline | 6000 ms | Failsafe timer before force-killing process tree |
| Command inject delay | 100 ms | Wait after PTY spawn before writing command |
| Idle timeout check | 60000 ms | Polling interval for `checkIdleTimeouts()` (every 60s) |
| Stale thinking threshold | 180000 ms | If no activity signal for 180s while in "thinking" state, emit synthetic idle event (v2 engine is event-driven, no polling timer) |

## Transient Sessions

Transient sessions are ephemeral Claude Code terminals spawned from the command bar (Ctrl+Shift+P). They differ from task-bound sessions in several ways:

- **No task association** - run at the project root with no Kanban task
- **No DB persistence** - no session record in the database
- **No resume capability** - killed on close, not suspendable
- **No queue** - spawned immediately regardless of concurrency limits

### Spawn Flow (`SESSION_SPAWN_TRANSIENT`)

1. Optionally checkout a target branch (falls back to current branch on failure)
2. Create a session directory at `.kangentic/sessions/<transientTaskId>/` for bridge files
3. Build Claude CLI command via `CommandBuilder` (with MCP server if enabled)
4. Call `SessionManager.spawn()` with `transient: true`

### Kill Flow (`SESSION_KILL_TRANSIENT`)

1. Remove the session from `SessionManager` (kills PTY)
2. Delete the session directory from disk (best-effort cleanup)

Transient sessions are tracked with a `transient_session_spawn` analytics event.

## AbortSignal Pattern

When a task moves rapidly between columns (e.g. drag-and-drop corrections), spawns from earlier transitions can become stale before they complete. The transition engine uses `AbortSignal` to cancel in-flight spawns:

1. Each task move creates an `AbortController` for the transition
2. If the same task moves again before the previous transition completes, the old controller is aborted
3. The `AbortSignal` is threaded through `executeTransition()`, `executeAction()`, and `executeSpawnAgent()`
4. At each async boundary (CLI detection, worktree creation, PTY spawn), the signal is checked via `signal?.throwIfAborted()`
5. If aborted, the spawn stops immediately - no PTY process is created

The `isAbortError()` utility in `src/shared/abort-utils.ts` provides a type guard for distinguishing abort errors from real errors in catch blocks.

## Terminal Paste Strategy

Terminal paste operations use xterm.js's built-in `terminal.paste()` method, which handles bracketed paste mode for the PTY. The paste path is unified:

- **Ctrl+V / Cmd+V** - intercepted by a custom key handler, reads clipboard, calls `terminal.paste()`
- **Context menu paste** - follows the same clipboard-read-then-paste path
- **Built-in xterm paste suppressed** - a `paste` event listener on the xterm helper textarea prevents the browser's native paste from double-sending text through xterm's `onData` handler

This ensures consistent behavior across keyboard shortcuts and context menu paste.

## Terminal Copy Strategy

Terminal copy operations write to the OS clipboard through the main process
(`clipboard:writeText`), which is synchronous and focus- and permission-independent.
`navigator.clipboard.writeText()` is deliberately not used: it rejects with `NotAllowedError`
when the document lacks focus, which is exactly the state during a native context-menu click and
when a TUI app emits its copy sequence. The copy paths are:

- **Ctrl+C with a selection / Ctrl+Shift+C** - the custom key handler reads the xterm selection,
  cleans soft-wraps, and writes it via the IPC.
- **Context menu Copy** - the native menu dispatches a `terminal-copy` event; the handler writes
  the selection via the same IPC.
- **OSC 52** - a TUI app (e.g. Claude Code's copy-on-select) copies by emitting
  `ESC]52;c;<base64>BEL`. A write-only OSC 52 handler decodes the payload and writes it via the
  IPC. Read requests (`Pd` is `?`) are ignored so a TUI can never read the user's clipboard back
  out of the terminal.
- **Scrollback replay** - recorded scrollback may contain OSC 52 sequences from an earlier copy;
  the replay path strips them so restoring a session (dialog reopen, resize, respawn) never
  clobbers the user's current clipboard.

### Terminal hyperlinks (OSC 8)

A TUI app can emit `ESC]8;;<url>ESC\` to mark text as a clickable hyperlink. Like OSC 52, these
are agent-controlled bytes with no user intent behind them - anything a session prints, `cat`s, or
echoes can carry one - so activation is gated rather than handed to the OS directly. `useTerminal`
installs a `linkHandler` (`src/renderer/utils/terminal-link-handler.ts`) that checks the URL
against `TERMINAL_LINK_SCHEMES` (`http:` / `https:` only, no `mailto:`) from
`src/shared/external-url.ts` and routes an allowed URL to the OS default browser via
`shell:openExternal`; anything else is dropped with a warning. Supplying this handler also replaces
xterm's built-in fallback, which would otherwise show a native `confirm()` dialog and then open the
URL in a bare, chrome-less `window.open()` window. The handler deliberately leaves
`allowNonHttpProtocols` unset so xterm's own http(s)-only filter stays live as an independent
second check; `tests/unit/terminal-link-handler.test.ts` statically scans `src/renderer` to keep it
that way.

## See Also

- [Configuration](configuration.md) -- permission modes and session limits
- [Agent Integration](agent-integration.md) -- command building, hook injection, per-agent CLI details
- [Transition Engine](transition-engine.md) -- what triggers spawns and suspends
- [Activity Detection](activity-detection.md) -- thinking/idle state from hooks
