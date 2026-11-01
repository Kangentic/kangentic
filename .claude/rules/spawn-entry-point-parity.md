---
paths:
  - "src/main/ipc/**"
  - "src/main/transition-engine/**"
  - "src/main/held-messages/**"
---

# Rule: every agent-spawn entry point runs the shared spawn preamble

Spawn-affecting behavior (the Advanced-override lock, agent resolution,
permission-mode resolution, auto_command handling) must apply identically no matter HOW a task's
agent gets spawned: drag move, create-into-spawn-column, backlog promote, MCP create, unarchive,
or startup recovery. Historically each handler hand-copied its own engine-call block, so a
behavior added to one path silently missed the others.

This shipped as a bug (#401 follow-up): the first-spawn override lock landed in only 2 of the 4
entry points that existed at the time. A task whose true first spawn happened via startup
recovery or unarchive never locked its overrides ("looks pinned but isn't"), and the create path
was self-contradictory - it persisted a locked agent while spawning with `agentOverride:
undefined`, which `executeSpawnAgent` resolves to the project default without ever reading
`task.agent_override`. auto_command has the same failure class: its recovery-move suppression
contract was kept in sync across three files by prose comments alone.

## The rule

- A **board-driven spawn** (task move, create, promote, MCP create, unarchive) routes through
  `spawnAgent` (`src/main/ipc/helpers/agent-spawn.ts`). Handlers never call
  `engine.executeTransition` / `engine.resumeSuspendedSession` directly.
- A **startup spawn** (crash recovery, reconcile) routes through `prepareAgentSpawn`
  (`src/main/transition-engine/session-startup/prepare-spawn.ts`). The one exception is a task
  the reconcile finds with no session record at all: it never had an agent, so `autoSpawnTasks`
  hands it to the board chokepoint (`autoSpawnForTask` -> `spawnAgent`, through the
  `startFirstAgent` callback the project-open paths in `handlers/projects.ts` pass), which makes
  its worktree before it starts the agent with the column's prompt. That hand-off is a startup
  caller and never passes `explicitStart`.
- Both chokepoints run `runSpawnPreamble`
  (`src/main/transition-engine/spawn-preamble.ts`): `lockAdvancedOverridesOnFirstSpawn`, THEN
  `resolveTargetAgent`, in that order - a just-locked `agent_override` must be what resolution
  picks up, and the resolved agent must be what the engine receives.
- **An agent started during a worktree's setup script is adopted by `spawnAgent`, never a third
  spawn path.** `TransitionEngine.launchEarlyAgent` starts a task's agent, hidden and with no
  prompt, while its new worktree's post-worktree script runs. Its one caller is
  `createEarlyAgentLauncher` (`agent-spawn.ts`), which resolves the launch through
  `previewSpawnPreamble`: the preamble's lock computed on a copy, written nowhere, since the
  launcher runs without the task lock. The task gets that agent only through `spawnAgent`'s own
  engine call, after the real preamble ran: the engine adopts it when the launch it would make is
  the same (`launchKey`) and discards it otherwise.
- Permission mode is resolved only via `resolveEffectivePermissionMode` (same module): a lane
  forcing `'plan'` always wins, else task -> lane -> global. No inline copies of that ternary.
- The **settings lane** the lock resolves against is the lane whose inherited values the New
  Task / Edit dialog displayed when the user configured the task (a drag move passes the SOURCE
  lane). When that lane is unknowable (create, promote, MCP create, unarchive), the destination
  the user chose is the fallback - never a lane no dialog ever showed.
- In-place restarts of an EXISTING session (`resumeTaskSession` in `handlers/session-resume.ts`,
  which the `SESSION_RESUME` handler and a phone resume of a paused task both call, and
  `restartSessionForSettingsChange` in `handlers/session-reconcile.ts`) are allowlisted direct
  engine calls; they are not first-spawn entry points.
- **A Resume after an entry goes through `spawnAgent`.** A move never starts a paused agent: it
  runs the destination's enter rows that need no agent and skips the rest (`agentPaused`). When
  the task entered its column after the pause, `resumeTaskSession` calls `spawnAgent` with
  `resumesEntry: true` instead of its direct engine call, so the Resume does what the entry
  would have done: the column's own session strategy and its enter rows that need the agent.
  An entry out of Done is a recovery move, so that start also passes `suppressAutoCommand`.
  `resumesEntry` lifts only the held-pause check, and `resumeTaskSession` is its one caller.
- A **user-initiated start in place** (the phone's `start-session` verb, via `startTaskSession` in
  `handlers/session-start.ts`) is NOT a third direct engine call. For a paused task it calls
  `resumeTaskSession`, the Resume button's own path, which runs no enter automations unless the
  task entered its column after the pause (the bullet above). Otherwise
  it routes through `autoSpawnForTask` -> `spawnAgent` with `explicitStart: true`, so the column's
  enter automations run as they do on a move. That flag lifts exactly two guards, the column's `auto_spawn` default
  and the manually-paused check, both of which exist to stop an AUTOMATIC spawn from overriding a
  choice the user made; the To Do / Done role gate stays. Only an explicit user gesture passes it.
  A create, promote, unarchive, startup, `reconcileAutoSpawnChange`, or workflow Resume
  (`resumeWorkflow`) caller never does, or a column flip or a Resume would silently un-pause a task
  the user paused.
- **A column's EXIT automations** (`handlers/task-move.ts`, Phase 1) are the third allowlisted
  direct engine call, and the only one that is not a spawn at all. They run the SOURCE column's
  exit rows as a task leaves, pass no `startAgent`, and the runner cannot start an agent on exit:
  a row that needs one and finds no session skips with that reason. Because the allowlist is per
  FILE, the test additionally pins that `task-move.ts` makes exactly ONE engine call, on `'exit'`,
  with no `startAgent` in the file, so this entry cannot quietly widen into a real spawn path.
- **Re-running ONE automation** (`helpers/automation-run-again.ts`, the `AUTOMATION_RUN_AGAIN`
  handler's shared path) is the fourth allowlisted direct engine call, and also not a spawn. It
  calls `executeSingleAutomation`, which passes no `startAgent`, so a row needing an agent and
  finding no session skips with that reason. That method is scanned alongside the two spawn sinks
  even though it cannot spawn: it is a second public way into the engine, and an unscanned one
  would grow callers with no test watching. A Move to column row (its manifest's `endsGroup`) runs
  outside the task lock, as at a turn end, and moves through `handleTaskMove`
  (`automations/turn-end/move-from-row.ts`), so any spawn it causes goes through `spawnAgent`.
- **A column's On agent turn end rows** (`automations/turn-end/turn-end-runner.ts`) are the fifth
  allowlisted direct engine call, and not a spawn either. They run when the agent working the task
  finishes a turn, act on that agent, pass no `startAgent`, and run outside the task lock. A Move
  to column row moves the task through `handleTaskMove`, so any spawn it causes goes through
  `spawnAgent` like every other move.
- Every file that calls `<receiver>.buildCommand(` calls `<receiver>.ensureTrust(cwd)` on that
  same receiver first. That is the adapter's pre-spawn global-config step (trust entries; for
  Claude also the `~/.claude.json` diff-panel write in `adapters/claude/diff-panel.ts`), and it
  applies on every path that BUILDS an agent command, including the Command Terminal, which is
  otherwise allowlisted out of both chokepoints. A path that spawns a caller-supplied command
  string without going through `buildCommand` (`SESSION_SPAWN` in `handlers/sessions.ts`) is
  outside what the scan verifies; route a new one through a chokepoint instead.
- Every file that calls `<receiver>.buildCommand(` also calls `resolveShimLaunch(`
  (`src/main/agent/shared/shim-launch.ts`) first, after `ensureTrust`, and hands the builder the
  resolved `agentPath` and `prompt`. On Windows an npm-installed CLI resolves to its `.cmd` shim,
  which a PowerShell or Git Bash host launches through cmd.exe, and cmd.exe keeps only the first
  line of a multi-line prompt (#353); the resolver swaps in the sibling shim the host can run, or
  flattens the prompt. The runtime wiring per chokepoint is pinned by
  `tests/unit/prepare-spawn-shim-launch-wiring.test.ts`, `tests/unit/transition-engine.test.ts`,
  and `tests/unit/transient-session-spawn-shim-launch.test.ts`.
- Every file that calls `<receiver>.buildCommand(` passes the session's own id as
  `ptySessionId` in its command options, the same id it hands `sessionManager.spawn` as `id`.
  An adapter that writes a file every session in a folder shares (Gemini's settings, Cursor's
  `mcp.json`, ...) holds it under that id (`SharedFolderHolds`), and the session layer releases
  it with the same id and the cwd the command was built for (`ManagedSession.commandCwd`).
  Never a task id: a task's sessions overlap. A built command that never reaches
  `sessionManager.spawn` (an early return, an abort, a skipped startup spawn) calls
  `releaseCommandHold` (`src/main/pty/lifecycle/adapter-lifecycle.ts`), or the folder's file stays
  for the rest of the run. A caller never releases after it calls `spawn()`: from there
  `SessionManager` releases a spawn that never ran, and a spawn that failed after its PTY started
  keeps the hold for that PTY's exit, so the file is never stripped under a running agent.
- **Held messages are claimed only where an opening message is built.** A message held for a task
  with no running agent (`src/main/held-messages/`) goes into the next agent's opening message,
  after the column's own. `spawnAgent` and `resumeTaskSession` call `claimHeldMessages` and fold
  the text in. Every other start (`prepareAgentSpawn`, the legacy Start agent row, a queued
  session's promotion) gets them from `registerHeldMessageFlush`, pasted once the first turn
  settles. A new start never claims on its own; it would race those two for the same rows.
- Adding a new spawn entry point means routing it through one of the two chokepoints, or adding
  a reasoned allowlist entry in the enforcement test AND updating this rule.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/spawn-entry-point-parity.test.ts` statically scans `src/main` and fails
  on (a) any `executeTransition` / `resumeSuspendedSession` / `executeSingleAutomation` /
  `launchEarlyAgent` call site outside the classified files, with `launchEarlyAgent` pinned to its
  one caller in `agent-spawn.ts` and that file to `previewSpawnPreamble`, (b) any `sessionManager.spawn(` call site outside the classified spawn sinks, (c) a
  chokepoint that stops calling `runSpawnPreamble` / `resolveEffectivePermissionMode`, (d)
  any `lockAdvancedOverridesOnFirstSpawn` call outside `spawn-preamble.ts`, (e) any
  `<receiver>.buildCommand(` call site with no earlier `<receiver>.ensureTrust(` on that same
  receiver in the same file, (f) any `<receiver>.buildCommand(` call site with no earlier
  `resolveShimLaunch(` in the same file, (g) any `explicitStart` reference outside
  `helpers/agent-spawn.ts` (its declaration, gates, and forward) and `handlers/session-start.ts`
  (its one user-gesture caller), with a companion assertion that the caller still passes it so
  the scan cannot pass vacuously, (h) the same for `resumesEntry`, allowed only in
  `helpers/agent-spawn.ts` and `handlers/session-resume.ts`, and (i) any
  `<receiver>.buildCommand(` call site with no `ptySessionId` property between it and the file's
  previous call site, or in a file that never calls `releaseCommandHold(`, and (j) any
  `claimHeldMessages(` call outside `agent-spawn.ts`, `session-resume.ts` and the held-messages
  module, with a companion assertion that both builders still claim. That
  scan proves line order, not control flow; the runtime ordering
  on the Command Terminal path is pinned separately by
  `tests/unit/transient-session-spawn-ensure-trust.test.ts`, which drives the handler and fails
  if the `await` is dropped or the call is removed. An
  unclassified new call site fails CI until it routes through a chokepoint or is deliberately
  allowlisted with a reason. Runs in CI via `npm run test:unit`.
- **Review:** the `session-debugger` agent (whose gate covers `transition-engine.ts` and
  task-move) is the fallback reviewer for spawn-path changes the mechanical scan cannot
  classify; `/code-review` flags spawn-affecting behavior added to one entry point only.

## Scope

Task-agent spawn paths in the main process (`src/main/ipc/**`, `src/main/transition-engine/**`).
Transient Command Terminal sessions (`transient-sessions.ts`), a workflow's own agent
(`workflows/workflow-agent.ts`, transient, on the Workflow agent setting's agent, read-only where
the adapter can enforce it), and the raw
`SESSION_SPAWN` passthrough are not task-agent spawns; they are allowlisted with reasons in the
test. The workflow agent still builds its command, so it runs `ensureTrust` and `resolveShimLaunch`
first like every other builder. The renderer never spawns directly.
