---
type: Reference
title: Session state machine
description: The in-memory SessionStatus versus the persisted SessionRecordStatus (which adds the DB-only orphaned), every transition and its trigger including held pauses and OS-killed recovery, and how session events and store state are scoped by projectId.
tags: [sessions, state-machine, status, orphaned]
sources:
  - resource: src/shared/types.ts
    title: SessionStatus and SessionRecordStatus
  - resource: src/main/pty/session-manager.ts
  - resource: src/main/transition-engine/session-lifecycle.ts
  - resource: src/renderer/stores/session-store.ts
---
# Session state machine

An agent CLI session is spawned, queued, suspended, resumed and recovered through one state machine. The steps of each live in the sibling concepts listed in the [sessions index](index.md).

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

## States

| State | Scope | Description |
|-------|-------|-------------|
| `queued` | Both | Waiting for a concurrency slot to open |
| `running` | Both | PTY is live, Claude Code CLI process is active |
| `suspended` | Both | PTY killed, but session ID and files preserved for resume |
| `exited` | Both | Process exited naturally or was killed; terminal state |
| `orphaned` | DB only | App crashed while session was running; discovered on next launch |

## Transitions

| From | To | Trigger |
|------|----|---------|
| `queued` | `running` | Concurrency slot opens, `SessionQueue` promotes |
| `queued` | `exited` | Session killed while still queued |
| `running` | `suspended` | Task moved to Done or `auto_spawn=false` column (a move to Done also closes the task's pop-out windows and destroys its offscreen lane, `closeTaskWindows`) |
| `running` | `suspended` | A column or Board Profile edit flips `auto_spawn` to false while the task is already sitting there, with no move at all (`reconcileAutoSpawnChange`, `suspended_by='system'`) |
| `running` | `suspended` | The user pauses it (`suspended_by='user'`), or Kangentic does while it waits on the user: the idle timeout (`suspended_by='auto'`) or the low-memory pause (`suspended_by='low_memory'`). All go through `pauseTaskSession`, which writes the record before the PTY goes down. All three are held pauses: no restart, column move or auto-spawn starts the task again until the user resumes it. The one exception is a running workflow's task under a `'low_memory'` pause, which the workflow's memory resume brings back once memory recovers (`workflow-memory-resume.ts`) |
| `running` | `exited` | Task moved to To Do (full cleanup via `cleanupTaskResources`; its pop-out windows close and its offscreen lane is destroyed, `closeTaskWindows`) |
| `running` | `exited` | Process exits naturally or is killed. Every `-> exited` transition also runs two browser cleanups, both guarded on the transition so a repeated `onExit` cannot re-run them and both best-effort so a failure never stops the record being marked exited. `destroyLanesForSession` destroys any offscreen browser surface that session opened, which is the guarantee that a surface cannot outlive its agent (see decision 29 in the [Embedded browser decision log](../embedded-browser/decision-log.md#29-an-agents-browser-survives-the-user-closing-the-task-window)). `releaseViewportOverridesForSession` puts back any viewport the session overrode on a PANE it did not own: a pane is the user's and survives the agent, so an override left behind renders a desktop layout at a fraction of the pane's width with nothing on screen explaining why ([decision 38](../embedded-browser/decision-log.md#38-an-agent-chooses-its-viewport-and-the-mechanism-follows-the-surface)). A lane needs no such release, since its viewport is its window and the window is being destroyed |
| `running` | `exited` | The agent CLI exited on its own while its shell PTY survived, so no PTY exit ever fired. The bg-shell watcher's [agent-absence sweep](agent-absence-sweep.md) confirms it over two probes and retires the session |
| `running` | `orphaned` | App crashes, leftover `running` DB record found on next launch |
| `queued` | `orphaned` | App crashes, leftover `queued` DB record found on next launch |
| `suspended` | `running` | Task moved to active column, resumed via `--resume` |
| `suspended` | `exited` | Replaced by a new session on resume (`retireRecord`) |
| `orphaned` | `running` | Session recovery on project open |
| `orphaned` | `exited` | Recovery dedup, or failed recovery (`retireRecord`) |
| `exited` | `exited` | A resume replaces a record that had already ended on its own (`retireRecord`'s fallback CAS). Confirms the row is out of the way without restamping `exited_at`, so the CLI's real end time survives a later restart; only the `suspended` and `orphaned` rows above get a fresh stamp |
| `orphaned` | `suspended` | Pause-on-restart setting upgrades a crashed session (`markRecordSuspended`) |
| `exited` | `running` | OS-killed (abnormal `exit_code`) session resumed by recovery on project open (`getInterruptedExited`) |
| `exited` | `suspended` | Interrupted-exited record CAS-upgraded by recovery (non-target / non-auto-spawn / auto-resume-off), or a PTY exit during app shutdown (onExit hardening) |
| `running` | `suspended` | App shutdown race: PTY exits while `isShuttingDown()` (onExit hardening keeps it resumable) |

## Project-Scoped Session State

Sessions from non-active projects must not interfere with the active project's terminal panel, activity icons, or store state. This is enforced at three levels:

1. **IPC event forwarding** -- All session events (`data`, `usage`, `activity`, `event`, `status`, `removed`, `exit`) include the session's `projectId`. The renderer filters events by comparing against the current project.
2. **Cache getters** -- `getUsage`, `getActivity`, and `getEventsCache` accept an optional `projectId` parameter. When provided, `SessionManager` returns only data for sessions belonging to that project.
3. **Store scoping** -- `syncSessions()` fetches usage and events scoped to the current project, but activity unscoped (sidebar badges need cross-project data). On project switch, `activeSessionId`, `dialogSessionIds`, `openTaskId`, `sessionUsage`, and `sessionEvents` are cleared; `sessions` and `sessionActivity` are preserved for the sidebar. A generation counter invalidates any in-flight `syncSessions()` calls from the previous project, and a snapshot-based merge preserves IPC-delivered status updates that arrive during the async gap.

**Sidebar exception:** Activity state (`thinking`/`idle`) is always forwarded and stored regardless of project, so the sidebar can show badge counts for all projects. Auto-focus and sync triggers are gated to the current project only.

## See Also

- [Settings](../../settings/index.md) -- permission modes and session limits
- [Agents](../../integrations/agents/index.md) -- command building, hook injection, per-agent CLI details
- [Transition Engine](../automations/transition-engine.md) -- what triggers spawns and suspends
- [Activity Detection](../activity/index.md) -- thinking/idle state from hooks
