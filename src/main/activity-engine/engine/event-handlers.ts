import { EventType, IdleReason } from '../../../shared/types';
import type { SessionEvent } from '../../../shared/types';
import { NO_ACTIVITY_HOLD_FLAG } from '../../../shared/background-shell-hold';
import {
  MAX_PENDING_EXEMPT_SHELL_TOOL_IDS,
  MAX_STARTED_SUBAGENT_IDS,
  MAX_TRACKED_SUBAGENT_IDS,
  type PendingTool,
  type SessionEngineState,
  type SubagentLifecycle,
} from './shapes';
import { looksLikeShellId } from '../background-shell/looks-like-shell-id';

/**
 * Record that this bg shell's launching command declared itself non-holding,
 * so the PostToolUse promotion can route the assigned shell id into
 * `exemptBackgroundShellIds` instead of `activeBackgroundShellIds`.
 *
 * Keyed by `toolId` because the promotion is a detail-SHAPE heuristic, not a
 * `toolId` correlation, and the flag cannot be re-read at PostToolUse (that
 * event's detail is the shell id; the command string is gone).
 *
 * No `toolId` means no exemption. That fails CLOSED - the shell keeps holding,
 * exactly as it does today - because the opposite failure is a false idle,
 * which silently hides an agent that needs the user.
 */
function rememberExemptShellToolId(state: SessionEngineState, toolId: string): void {
  addToBoundedMemo(state.pendingExemptShellToolIds, toolId);
}

/**
 * Remember a shell id the agent marked as a service before the engine saw it
 * start (`pendingServiceShellIds`), so its promotion lands it exempt. FIFO
 * capped like `rememberExemptShellToolId`.
 */
export function rememberPendingServiceShellId(state: SessionEngineState, shellId: string): void {
  addToBoundedMemo(state.pendingServiceShellIds, shellId);
}

/**
 * Add to one of the exemption memos, FIFO-evicting at
 * `MAX_PENDING_EXEMPT_SHELL_TOOL_IDS` so a promotion that never comes cannot
 * strand entries forever. `Set` iterates in insertion order, so the first key
 * is the oldest. A value already present keeps its place.
 */
function addToBoundedMemo(memo: Set<string>, value: string): void {
  if (memo.has(value)) return;
  if (memo.size >= MAX_PENDING_EXEMPT_SHELL_TOOL_IDS) {
    const oldest = memo.values().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.add(value);
}

/**
 * Record a correlated subagent's latest lifecycle event. Deleting first moves
 * the id to the newest position, so the cap evicts by last write rather than
 * by first sighting.
 *
 * At the cap the oldest STOPPED id goes first. A stopped id is kept only to
 * recognize a duplicate stop seconds later, while a live id is kept for its
 * whole run so that a re-start takes no second slot (task #835). Evicting the
 * oldest id regardless of state would drop a long-running live agent once a
 * large fan-out wrote enough newer ids. Only a ledger that holds no stopped id
 * evicts a live one.
 */
function recordSubagentLifecycle(
  state: SessionEngineState,
  subagentId: string,
  lifecycle: SubagentLifecycle,
): void {
  const ledger = state.subagentLifecycleById;
  ledger.delete(subagentId);
  if (ledger.size >= MAX_TRACKED_SUBAGENT_IDS) {
    // `Map` iterates in insertion order, so the first match is the oldest.
    let evictedId: string | undefined;
    for (const [trackedId, trackedLifecycle] of ledger) {
      if (trackedLifecycle === 'stopped') {
        evictedId = trackedId;
        break;
      }
    }
    evictedId ??= ledger.keys().next().value;
    if (evictedId !== undefined) ledger.delete(evictedId);
  }
  ledger.set(subagentId, lifecycle);
}

/**
 * Remember that a `subagent_start` named this id (`startedSubagentIds`).
 * Deleting first moves a re-started id to the newest position, so the cap
 * evicts the agent started longest ago.
 */
function rememberStartedSubagent(state: SessionEngineState, subagentId: string): void {
  const started = state.startedSubagentIds;
  started.delete(subagentId);
  if (started.size >= MAX_STARTED_SUBAGENT_IDS) {
    // `Set` iterates in insertion order, so the first key is the oldest.
    const oldest = started.values().next().value;
    if (oldest !== undefined) started.delete(oldest);
  }
  started.add(subagentId);
}

/**
 * Zero `subagentDepth` and mark every live correlated subagent stopped. Every
 * path that force-releases the depth goes through here, so the ledger agrees
 * with the count: the released agents no longer hold a slot, and a late named
 * stop from one of them is a duplicate rather than a decrement that would take
 * the slot of a subagent started after the reset.
 */
export function releaseSubagentSlots(state: SessionEngineState): void {
  state.subagentDepth = 0;
  for (const [subagentId, lifecycle] of state.subagentLifecycleById) {
    if (lifecycle === 'live') state.subagentLifecycleById.set(subagentId, 'stopped');
  }
}

/** The tool events an agent's `PreToolUse` / `PostToolUse` / `PostToolUseFailure` hooks emit. */
const TOOL_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  EventType.ToolStart,
  EventType.ToolEnd,
  EventType.Interrupted,
  EventType.BackgroundShellStart,
  EventType.BackgroundShellEnd,
]);

/**
 * Is this a tool event from an internal CLI agent: one whose `subagentId`
 * never fired a `subagent_start`?
 *
 * Claude Code runs agents of its own after a Stop, each ending in an id-only
 * stop the engine already ignores (`detail === ''`). Some run tools, and some
 * of those tools never end: most likely the run that answers the prompt
 * suggestion ahead of time, which stops at the first tool it may not run.
 * Counted, such a `tool_start` reopened the turn the Stop had ended, which
 * took that turn's end automations away (they judge only the latest turn) and
 * held the card working until the stuck-pending-tools watchdog.
 *
 * Never started, not merely not live: a background subagent stopped once is
 * re-prompted and runs tools after its first named stop (task #759), and its
 * id reads `'stopped'`. So the test reads `startedSubagentIds`, which the
 * lifecycle ledger's stopped-first eviction cannot reach. And not when an
 * id-less start holds a slot (more depth than live ids): an older CLI whose
 * SubagentStart carries no id may still put one on the subagent's tool hooks.
 */
export function isInternalAgentToolEvent(
  state: Pick<SessionEngineState, 'subagentDepth' | 'subagentLifecycleById' | 'startedSubagentIds'>,
  event: SessionEvent,
): boolean {
  if (!event.subagentId || !TOOL_EVENT_TYPES.has(event.type)) return false;
  if (state.startedSubagentIds.has(event.subagentId)) return false;
  let liveIds = 0;
  for (const lifecycle of state.subagentLifecycleById.values()) {
    if (lifecycle === 'live') liveIds += 1;
  }
  return state.subagentDepth <= liveIds;
}

/**
 * Pure event-to-state mutations for the activity engine.
 *
 * Each function takes the current state and an event and mutates the
 * state in place. No engine reference, no IO, no transitions - the
 * engine layers timer scheduling and predicate evaluation on top.
 */

/**
 * Apply the counter delta for a single event.
 *
 * - `ToolStart`           pushes `{id, name}` to the stack, increments count.
 * - `ToolEnd`/`Interrupted` removes one entry from the stack (id-match preferred,
 *                         LIFO-by-name fallback, raw pop for Interrupted) and
 *                         decrements count. When the count reaches zero,
 *                         hard-resets the stack so any dangling names
 *                         (from dropped hooks) clear.
 * - `Idle` (non-permission) clears all pending tool tracking - the agent's
 *                         turn is done, any unmatched ToolStart events
 *                         are stale by definition (PostToolUse hook
 *                         dropped, tool force-killed, etc.).
 * - `SubagentStart`       increments `subagentDepth`, EXCEPT a start whose
 *                         `subagentId` is already live, which holds the slot
 *                         it has (task #835). With a `subagentId` it marks
 *                         that id live (re-opening a continued agent).
 * - `SubagentStop`        decrements `subagentDepth` (clamped at zero),
 *                         EXCEPT an empty-string detail ("") which is a
 *                         subagent's spurious inner-loop Stop and is ignored,
 *                         and a stop whose `subagentId` is already stopped,
 *                         which is a duplicate and is ignored (task #759).
 * - `BackgroundShellStart` first closes any in-flight pending tool whose
 *                         id matches `event.toolId` (a foreground Bash that
 *                         Claude auto-backgrounded on timeout - the tool
 *                         moved to the background rather than ending), then
 *                         tracks by `shell_id` (when the detail is id-shaped)
 *                         or anonymously (empty / command-string fallback).
 *                         When PreToolUse + PostToolUse fire as a pair,
 *                         the second arrival "promotes" an anonymous
 *                         slot to a named one to keep total count constant.
 *                         A named start lands exempt when its launch carried
 *                         the no-activity-hold flag (the `toolId` memo, or
 *                         `noActivityHold` on the start for a CLI with no
 *                         tool id) or the agent marked the id first.
 * - `BackgroundShellEnd`  decrements the named shell if the id matches,
 *                         else drains anonymous (ONLY when the end carried
 *                         no id at all - an id-shaped-but-unmatched end is
 *                         a no-op, never a fallback decrement), else bumps
 *                         `unmatchedBgShellEnd`. The agent told us
 *                         SOMETHING ended, but an unattributable end must
 *                         never corrupt a counter it wasn't naming.
 */
export function updateCounters(state: SessionEngineState, event: SessionEvent): void {
  switch (event.type) {
    case EventType.ToolStart:
      state.pendingToolCount += 1;
      if (event.tool) {
        // toolId may be undefined for adapters without correlation IDs;
        // the stack still tracks the name and falls back to LIFO matching.
        state.pendingToolStack.push({
          id: event.toolId,
          name: event.tool,
          ...(event.launchesSubagent === true ? { launchesSubagent: true } : {}),
        });
        state.currentTool = event.tool;
      }
      // A background launch arrives here, not as a BackgroundShellStart, when
      // the adapter's PreToolUse remap does not cover the tool (Claude's
      // PowerShell, task #857) or when Claude moves a foreground command to the
      // background itself. Its PostToolUse promotion closes this pending tool
      // and reads the memo, so the flag must be remembered here too.
      if (event.toolId !== undefined && event.detail?.includes(NO_ACTIVITY_HOLD_FLAG) === true) {
        rememberExemptShellToolId(state, event.toolId);
      }
      break;
    case EventType.ToolEnd:
    case EventType.Interrupted:
      // A flagged command that ran in the foreground and ended never promotes,
      // so its memo goes with it.
      if (event.toolId !== undefined) {
        state.pendingExemptShellToolIds.delete(event.toolId);
      }
      state.pendingToolCount = Math.max(0, state.pendingToolCount - 1);
      // Match priority:
      //   1. By correlation id when both events carry one (precise
      //      across out-of-order arrival and duplicate names).
      //   2. By LIFO-by-name when only the name is available.
      //   3. By raw pop for Interrupted (no tool name carried).
      if (event.toolId) {
        const idx = state.pendingToolStack.findIndex((entry) => entry.id === event.toolId);
        if (idx >= 0) {
          state.pendingToolStack.splice(idx, 1);
        } else if (event.tool) {
          // ID didn't match (drift from hook drop or version skew); fall
          // back to LIFO-by-name so we still drain the stack.
          for (let i = state.pendingToolStack.length - 1; i >= 0; i--) {
            if (state.pendingToolStack[i].name === event.tool) {
              state.pendingToolStack.splice(i, 1);
              break;
            }
          }
        }
      } else if (event.tool) {
        for (let i = state.pendingToolStack.length - 1; i >= 0; i--) {
          if (state.pendingToolStack[i].name === event.tool) {
            state.pendingToolStack.splice(i, 1);
            break;
          }
        }
      } else if (state.pendingToolStack.length > 0) {
        // Interrupted has no tool name and no id. Pop most recent.
        // Note: the engine's Interrupted bypass (in activity-engine.ts)
        // hard-clears all of this immediately afterward; we still do the
        // pop so an Interrupted that DOESN'T hit the bypass (e.g. legacy
        // event replay through processEvent) maintains invariants.
        state.pendingToolStack.pop();
      }
      // currentTool falls back to whatever's still in flight.
      state.currentTool = state.pendingToolStack[state.pendingToolStack.length - 1]?.name ?? null;
      if (state.pendingToolCount === 0) {
        // Hard reset: even if a hook drop left names dangling, the
        // count says nothing is in flight. Clear both.
        state.pendingToolStack.length = 0;
        state.currentTool = null;
      }
      break;
    case EventType.Idle: {
      // Idle (Stop hook) means the agent's turn is done. Any unmatched
      // ToolStart events are stale by definition - PostToolUse hook
      // dropped, the tool was force-killed, or some other reliability
      // gap. Clear them.
      //
      // Permission idles are the exception: the agent paused to ask
      // for approval and may resume the same tool, so leave counters
      // intact.
      //
      // Why this matters: a stuck `pendingToolCount > 0` permanently
      // blocks the bg-shell watcher's pending-tools guard from
      // firing natural-exit, which leaves bg shells stuck in the
      // count after the agent has officially stopped.
      if (event.detail !== IdleReason.Permission) {
        state.pendingToolCount = 0;
        state.pendingToolStack.length = 0;
        state.currentTool = null;
      }
      break;
    }
    case EventType.SubagentStart:
      // A start takes a slot unless its id already holds one. A driver can
      // re-task an agent with SendMessage before that agent's first run fired
      // its named stop, and the second start would give one agent two slots
      // (task #835). That start bumps `duplicateSubagentStart` instead. If the
      // first run's stop lands after the second start, it releases the one
      // slot and the continuation's own stop reads as a duplicate. The stream
      // cannot tell the two stops apart, so the depth reads 0 for the rest of
      // the continuation. See "Re-started live subagent" in
      // docs/architecture/activity/predicate.md.
      if (event.subagentId && state.subagentLifecycleById.get(event.subagentId) === 'live') {
        state.compensationCounters.duplicateSubagentStart += 1;
      } else {
        state.subagentDepth += 1;
      }
      // A SendMessage continuation fires a fresh SubagentStart under the SAME
      // id (captured on CLI 2.1.290), so a start always re-marks the id live.
      // Without this, the continued agent's legitimate stop would read as a
      // duplicate and leave depth one too high until `timer:stuck-subagent`.
      if (event.subagentId) {
        recordSubagentLifecycle(state, event.subagentId, 'live');
        rememberStartedSubagent(state, event.subagentId);
      }
      break;
    case EventType.SubagentStop:
      // An empty-STRING detail ("") marks a subagent's spurious inner-loop
      // Stop: each subagent fires one when its inner turn ends, long before
      // the Task tool returns its authoritative NAMED terminal Stop. Counting
      // it over-decrements depth while the subagent is still live, which lets
      // a later idle/idle_hint end the parent turn early -> false idle
      // (task #237; real capture 87524f38, where every subagent emitted
      // exactly one empty inner stop then one named terminal stop). A
      // detail-LESS stop (no `detail` field at all, e.g. session-008's
      // stream) and a named stop are real terminal stops and still decrement.
      // The guard is strictly `=== ''`, NOT `!event.detail`: a detail-less
      // terminal stop must still count, and session-008's replay test is the
      // CI backstop that fails if this is ever weakened to `!event.detail`.
      //
      // This check runs FIRST and never records the stop's id: an ignored inner
      // stop that marked its id stopped would make that agent's real named stop
      // read as a duplicate below, leaving depth stuck one too high.
      if (event.detail === '') {
        state.compensationCounters.ignoredInnerSubagentStop += 1;
        break;
      }
      // A second NAMED stop for one agent. A background subagent that ends its
      // turn without calling SubagentHandback fires a named stop, is
      // re-prompted by the CLI's `[handback-send-enforce]` message, and fires
      // another after the handback. Counting both took a live sibling's slot,
      // so the parent's Stop passed the depth-0 turn-ending gate while a
      // background test-builder was still running (task #759, session-030).
      // An id-less stop skips this and decrements as it always has. An empty
      // id names no agent, so it counts as id-less too: as a ledger key, two
      // agents both stopping with `""` would read as one agent's duplicate.
      if (
        event.subagentId
        && state.subagentLifecycleById.get(event.subagentId) === 'stopped'
      ) {
        state.compensationCounters.duplicateSubagentStop += 1;
        break;
      }
      state.subagentDepth = Math.max(0, state.subagentDepth - 1);
      if (event.subagentId) {
        recordSubagentLifecycle(state, event.subagentId, 'stopped');
      }
      break;
    case EventType.BackgroundShellStart: {
      // A foreground Bash that Claude auto-backgrounds on timeout arrives
      // here as a promotion of an in-flight tool: its PreToolUse emitted a
      // plain ToolStart (run_in_background was absent at launch), and this
      // PostToolUse carries the assigned shell id, remapped to
      // BackgroundShellStart by the adapter. Close the matching pending tool
      // by correlation id - the tool didn't END, it MOVED to the background,
      // so leaving it pending would orphan the count (the matching ToolEnd
      // never arrives) and stick the session thinking until the 5-min
      // stuck-pending-tools watchdog. Id-only match (no LIFO-by-name
      // fallback) so an unrelated foreground tool is never closed by
      // mistake. The explicit run_in_background path has no pending tool
      // under this id (its PreToolUse was already a BackgroundShellStart, not
      // a ToolStart), so this is a no-op there.
      if (event.toolId) {
        const pendingIndex = state.pendingToolStack.findIndex((entry) => entry.id === event.toolId);
        if (pendingIndex >= 0) {
          state.pendingToolStack.splice(pendingIndex, 1);
          state.pendingToolCount = Math.max(0, state.pendingToolCount - 1);
          state.currentTool = state.pendingToolStack[state.pendingToolStack.length - 1]?.name ?? null;
          if (state.pendingToolCount === 0) {
            state.pendingToolStack.length = 0;
            state.currentTool = null;
          }
        }
      }
      // PreToolUse fires this without a shell_id (the agent hasn't
      // assigned one yet) - we count anonymously. PostToolUse fires
      // this AGAIN once Claude Code has assigned a shell_id to the
      // bg shell, this time with the id in detail. We treat the
      // PostToolUse arrival as PROMOTION: convert one anonymous
      // slot to a named slot, keeping the total count constant.
      //
      // Detail-shape rules (see `looksLikeShellId`):
      //   - whitespace/long/non-id chars => anonymous (typical
      //     PreToolUse where Claude falls back to command string)
      //   - id-shaped (alphanumeric/-/_, 1-64 chars) => named
      //
      // The promote heuristic (anonymous > 0 AND id-shaped detail
      // AND id not already in named set) keeps total constant when
      // PreToolUse + PostToolUse fire as a pair. If an id arrives
      // without a prior anonymous slot (e.g., a hook chain that
      // only fires PostToolUse), the named entry is added without
      // promotion - that scenario doesn't double-count either.
      //
      // The sentinel is read here rather than in the `else` arm because
      // `looksLikeShellId` is a `value is string` predicate: inside its `else`
      // TypeScript narrows `event.detail` to `undefined`, which makes the
      // command-string case (a real string that simply is not id-shaped)
      // unreachable to the checker even though it is the common one.
      const declaresNoActivityHold = event.detail?.includes(NO_ACTIVITY_HOLD_FLAG) === true;
      if (looksLikeShellId(event.detail)) {
        if (
          state.activeBackgroundShellIds.has(event.detail)
          || state.exemptBackgroundShellIds.has(event.detail)
        ) {
          // Duplicate - same shell_id seen before. No-op.
          break;
        }
        // EXEMPT promotion. This shell's PreToolUse (a background_shell_start,
        // or the tool_start of a launch the remap does not cover) carried
        // NO_ACTIVITY_HOLD_FLAG, so the caller declared it non-holding (see
        // `background-shell-hold.ts`). Drain any anonymous slot it has been
        // occupying since PreToolUse and park the named id in the exempt set,
        // which no activity site sums - so the shell stays fully tracked for
        // liveness while contributing nothing to the predicate.
        //
        // The agent can also have marked this id as a service before the
        // engine saw it start (`pendingServiceShellIds`): same landing. A CLI
        // whose payloads carry no tool id reports the flag on the start itself
        // (`noActivityHold`), since no memo can be keyed for it.
        const exemptToolId = event.toolId;
        const flaggedAtLaunch = event.noActivityHold === true
          || (exemptToolId !== undefined && state.pendingExemptShellToolIds.has(exemptToolId));
        const markedBeforeStart = state.pendingServiceShellIds.has(event.detail);
        if (flaggedAtLaunch || markedBeforeStart) {
          if (exemptToolId !== undefined) state.pendingExemptShellToolIds.delete(exemptToolId);
          state.pendingServiceShellIds.delete(event.detail);
          if (state.anonymousBackgroundShellCount > 0) {
            state.anonymousBackgroundShellCount -= 1;
          }
          state.exemptBackgroundShellIds.add(event.detail);
          break;
        }
        if (state.anonymousBackgroundShellCount > 0) {
          // Promote: swap one anonymous slot for this named id.
          state.anonymousBackgroundShellCount -= 1;
        }
        state.activeBackgroundShellIds.add(event.detail);
      } else {
        // Anonymous PreToolUse arrival. Count it exactly as before - including
        // for an exempt shell, whose sub-second wait for its id is not worth a
        // parallel counter and whose every drain path would then need one.
        // Only the memo is extra.
        state.anonymousBackgroundShellCount += 1;
        if (declaresNoActivityHold && event.toolId !== undefined) {
          rememberExemptShellToolId(state, event.toolId);
        }
      }
      break;
    }
    case EventType.BackgroundShellEnd: {
      // KillBash's hook fires this with detail = tool_input.shell_id.
      // If we tracked the start under that id, decrement the named set.
      // An end with NO id at all (a true anonymous-shell signal) drains
      // the anonymous count instead.
      //
      // An id-shaped detail that does NOT match a tracked named shell is
      // UNATTRIBUTABLE and must NEVER fall through to draining the
      // anonymous count: the end explicitly named a shell, so treating the
      // miss as "some anonymous shell must have ended" would let a stray or
      // mis-remapped id-carrying end (e.g. a version-skewed hook payload)
      // silently mask a real, unrelated anonymous shell's exit. We do not
      // drain an arbitrary named shell either, for the same reason. Instead
      // it is a no-op that bumps a compensation counter, bounding the blast
      // radius of any input-layer mistake. Real orphans are still reclaimed
      // by the process-tree watcher, the transcript drain, and the bg-shell
      // escape hatch.
      const shellId = event.detail;
      if (shellId !== undefined) {
        if (state.activeBackgroundShellIds.has(shellId)) {
          state.activeBackgroundShellIds.delete(shellId);
        } else if (state.exemptBackgroundShellIds.has(shellId)) {
          // An exempt shell exiting is a normal drain, not an unattributable
          // end - it was tracked all along, just not in the predicate's set.
          state.exemptBackgroundShellIds.delete(shellId);
        } else {
          state.compensationCounters.unmatchedBgShellEnd += 1;
        }
      } else if (state.anonymousBackgroundShellCount > 0) {
        state.anonymousBackgroundShellCount -= 1;
      } else {
        state.compensationCounters.unmatchedBgShellEnd += 1;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Update `permissionPending` based on the event. Permission is set by
 * `Idle` events with detail=permission, and cleared by the awaited tool
 * itself starting/ending at ANY depth (`permissionAwaitedToolId` match - the
 * prompt was approved and the tool ran), or by a wake from the main agent:
 * Prompt, Interrupted, TurnFailed, a non-permission Idle, a SubagentStart
 * when the awaited call is the one that starts subagents, and a depth-0
 * ToolStart/ToolEnd that cannot be told apart from the awaited call (no id
 * on one side). A parallel sibling's start, end or subagent never clears it.
 */
export function updatePermissionFlag(state: SessionEngineState, event: SessionEvent): void {
  // Set on Idle/permission. Record which tool the prompt was raised for:
  // permission prompts fire between PreToolUse and execution, so the
  // awaiting tool is on the pending stack (left intact by the permission
  // exemption in updateCounters). The newest entry the event names wins,
  // else the top: a parallel sibling can start after the awaited tool
  // (Claude's ToolSearch beside AskUserQuestion), so the top alone
  // misattributed it. With parallel subagents the top can still belong
  // to a racing tool_start when the event names no tool, but the
  // PreToolUse-to-prompt window is sub-second and the failure mode (an
  // early clear) is bounded - unlike the stuck flag this prevents.
  if (event.type === EventType.Idle && event.detail === IdleReason.Permission) {
    const awaited = awaitedPendingTool(state.pendingToolStack, event.tool);
    state.permissionPending = true;
    state.permissionAwaitedToolId = awaited?.id ?? null;
    state.permissionSiblingToolIds.clear();
    for (const pending of state.pendingToolStack) {
      if (pending !== awaited && pending.id !== undefined) state.permissionSiblingToolIds.add(pending.id);
    }
    // The newest wait names the kind: a question raised while an approval is
    // still open (a subagent's prompt beside its parent's) is what shows.
    state.permissionWaitKind = event.waitKind ?? null;
    return;
  }
  // A sibling already running when the prompt opened finished. That says
  // nothing about the answer, so the prompt stays open.
  if (
    event.type === EventType.ToolEnd
    && event.toolId !== undefined
    && event.toolId !== state.permissionAwaitedToolId
    && state.permissionSiblingToolIds.delete(event.toolId)
  ) {
    return;
  }
  // The awaited tool itself started/ended: the prompt was approved and
  // the tool ran. Clears at ANY depth - the depth-0 gate below exists so
  // unrelated subagent tool churn cannot dismiss a pending prompt, but an
  // id match is precise attribution, not churn. (updateCounters runs
  // before this and may have already popped the stack, so match on the
  // event's own toolId, never the stack.)
  const awaitedToolResolved =
    (event.type === EventType.ToolStart || event.type === EventType.ToolEnd)
    && event.toolId !== undefined
    && event.toolId === state.permissionAwaitedToolId;
  // A subagent's start answers the prompt only when the awaited call is the
  // one that starts subagents: approving it is what starts this one. A
  // parallel subagent launched in the same batch says nothing about the
  // prompt. It once cleared an Artifact prompt 4 ms after it opened, the card
  // read working, then idle, and a nudge's Enter approved the call.
  const awaitedLaunchesSubagent = state.permissionAwaitedToolId !== null
    && state.pendingToolStack.some((entry) => entry.id === state.permissionAwaitedToolId && entry.launchesSubagent === true);
  // Another call's start or end at depth 0 answers the prompt only when the
  // two cannot be told apart: no id on the event, or none on the awaited call.
  // With both ids known, a different call is a parallel sibling, not the
  // answer, and the prompt stays open until its own call starts or ends. A
  // denial fires no hook at all; the transcript poll (`markPermissionRejected`)
  // and the turn's own end close it.
  const unattributedMainAgentTool = (event.type === EventType.ToolStart || event.type === EventType.ToolEnd)
    && state.subagentDepth === 0
    && (event.toolId === undefined || state.permissionAwaitedToolId === null);
  // Clear on signals from the main agent (depth 0) or unambiguous wakes.
  const isPermissionClearingSignal =
    awaitedToolResolved
    || event.type === EventType.Prompt
    || event.type === EventType.Interrupted
    || event.type === EventType.TurnFailed
    || (event.type === EventType.SubagentStart && awaitedLaunchesSubagent)
    || (event.type === EventType.Idle && event.detail !== IdleReason.Permission)
    || unattributedMainAgentTool;
  if (isPermissionClearingSignal) clearPermissionWait(state);
}

/**
 * End the pending permission wait. The flag, the tool it awaits, its kind and
 * the siblings it ignores are cleared together, so no clear site can leave a
 * stale kind or sibling set behind.
 */
export function clearPermissionWait(state: SessionEngineState): void {
  state.permissionPending = false;
  state.permissionAwaitedToolId = null;
  state.permissionWaitKind = null;
  state.permissionSiblingToolIds.clear();
}

/**
 * The pending tool a permission prompt waits on: the newest entry named
 * `toolName` when the event names one and it is on the stack, else the top.
 */
function awaitedPendingTool(stack: PendingTool[], toolName: string | undefined): PendingTool | undefined {
  if (toolName) {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].name === toolName) return stack[index];
    }
  }
  return stack[stack.length - 1];
}
