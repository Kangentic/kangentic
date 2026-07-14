---
paths:
  - "src/main/ipc/**"
  - "src/main/transition-engine/**"
---

# Rule: every agent-spawn entry point runs the shared spawn preamble

Spawn-affecting behavior (the first-spawn Advanced-override lock, agent resolution,
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
  (`src/main/transition-engine/session-startup/prepare-spawn.ts`).
- Both chokepoints run `runSpawnPreamble`
  (`src/main/transition-engine/spawn-preamble.ts`): `lockAdvancedOverridesOnFirstSpawn`, THEN
  `resolveTargetAgent`, in that order - a just-locked `agent_override` must be what resolution
  picks up, and the resolved agent must be what the engine receives.
- Permission mode is resolved only via `resolveEffectivePermissionMode` (same module): a lane
  forcing `'plan'` always wins, else task -> lane -> global. No inline copies of that ternary.
- The **settings lane** the lock resolves against is the lane whose inherited values the New
  Task / Edit dialog displayed when the user configured the task (a drag move passes the SOURCE
  lane). When that lane is unknowable (create, promote, MCP create, unarchive), the destination
  the user chose is the fallback - never a lane no dialog ever showed.
- In-place restarts of an EXISTING session (`SESSION_RESUME` in `handlers/sessions.ts`,
  `restartSessionForSettingsChange` in `handlers/session-reconcile.ts`) are the only allowlisted
  direct engine calls; they are not first-spawn entry points.
- Adding a new spawn entry point means routing it through one of the two chokepoints, or adding
  a reasoned allowlist entry in the enforcement test AND updating this rule.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/spawn-entry-point-parity.test.ts` statically scans `src/main` and fails
  on (a) any `executeTransition` / `resumeSuspendedSession` call site outside the classified
  files, (b) any `sessionManager.spawn(` call site outside the classified spawn sinks, (c) a
  chokepoint that stops calling `runSpawnPreamble` / `resolveEffectivePermissionMode`, and (d)
  any `lockAdvancedOverridesOnFirstSpawn` call outside `spawn-preamble.ts`. An unclassified new
  call site fails CI until it routes through a chokepoint or is deliberately allowlisted with a
  reason. Runs in CI via `npm run test:unit`.
- **Review:** the `session-debugger` agent (whose gate covers `transition-engine.ts` and
  task-move) is the fallback reviewer for spawn-path changes the mechanical scan cannot
  classify; `/code-review` flags spawn-affecting behavior added to one entry point only.

## Scope

Task-agent spawn paths in the main process (`src/main/ipc/**`, `src/main/transition-engine/**`).
Transient Command Terminal sessions (`transient-sessions.ts`) and the raw `SESSION_SPAWN`
passthrough are not task-agent spawns; they are allowlisted with reasons in the test. The
renderer never spawns directly.
