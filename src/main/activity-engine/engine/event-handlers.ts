import { EventType, IdleReason } from '../../../shared/types';
import type { SessionEvent } from '../../../shared/types';
import type { SessionEngineState } from './shapes';
import { looksLikeShellId } from '../background-shell/looks-like-shell-id';

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
 * - `SubagentStart`       increments `subagentDepth`.
 * - `SubagentStop`        decrements `subagentDepth` (clamped at zero),
 *                         EXCEPT an empty-string detail ("") which is a
 *                         subagent's spurious inner-loop Stop and is ignored.
 * - `BackgroundShellStart` first closes any in-flight pending tool whose
 *                         id matches `event.toolId` (a foreground Bash that
 *                         Claude auto-backgrounded on timeout - the tool
 *                         moved to the background rather than ending), then
 *                         tracks by `shell_id` (when the detail is id-shaped)
 *                         or anonymously (empty / command-string fallback).
 *                         When PreToolUse + PostToolUse fire as a pair,
 *                         the second arrival "promotes" an anonymous
 *                         slot to a named one to keep total count constant.
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
        state.pendingToolStack.push({ id: event.toolId, name: event.tool });
        state.currentTool = event.tool;
      }
      break;
    case EventType.ToolEnd:
    case EventType.Interrupted:
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
      state.subagentDepth += 1;
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
      if (event.detail === '') {
        state.compensationCounters.ignoredInnerSubagentStop += 1;
        break;
      }
      state.subagentDepth = Math.max(0, state.subagentDepth - 1);
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
      if (looksLikeShellId(event.detail)) {
        if (state.activeBackgroundShellIds.has(event.detail)) {
          // Duplicate - same shell_id seen before. No-op.
          break;
        }
        if (state.anonymousBackgroundShellCount > 0) {
          // Promote: swap one anonymous slot for this named id.
          state.anonymousBackgroundShellCount -= 1;
        }
        state.activeBackgroundShellIds.add(event.detail);
      } else {
        state.anonymousBackgroundShellCount += 1;
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
 * `Idle` events with detail=permission, and cleared by signals from
 * the main agent (Prompt, Interrupted, SubagentStart, non-permission
 * Idle, depth-0 ToolStart/ToolEnd) or by the awaited tool itself
 * starting/ending at ANY depth (`permissionAwaitedToolId` match - the
 * prompt was approved and the tool ran).
 */
export function updatePermissionFlag(state: SessionEngineState, event: SessionEvent): void {
  // Set on Idle/permission. Record which tool the prompt was raised for:
  // permission prompts fire between PreToolUse and execution, so the
  // awaiting tool is the top of the pending stack (left intact by the
  // permission exemption in updateCounters). With parallel subagents the
  // top can in principle belong to a racing tool_start, but the
  // PreToolUse-to-prompt window is sub-second and the failure mode (an
  // early clear) is bounded - unlike the stuck flag this prevents.
  if (event.type === EventType.Idle && event.detail === IdleReason.Permission) {
    state.permissionPending = true;
    state.permissionAwaitedToolId =
      state.pendingToolStack[state.pendingToolStack.length - 1]?.id ?? null;
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
  // Clear on signals from the main agent (depth 0) or unambiguous wakes.
  const isPermissionClearingSignal =
    awaitedToolResolved
    || event.type === EventType.Prompt
    || event.type === EventType.Interrupted
    || event.type === EventType.TurnFailed
    || event.type === EventType.SubagentStart
    || (event.type === EventType.Idle && event.detail !== IdleReason.Permission)
    || ((event.type === EventType.ToolStart || event.type === EventType.ToolEnd)
        && state.subagentDepth === 0);
  if (isPermissionClearingSignal) {
    state.permissionPending = false;
    state.permissionAwaitedToolId = null;
  }
}
