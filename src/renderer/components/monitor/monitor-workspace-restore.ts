/**
 * Which of a saved monitor layout's windows this host may actually take back.
 *
 * The monitor's detail layout is persisted globally (`AppConfig.monitorWorkspace`) so
 * an open detail survives the move between the in-app monitor and its pop-out - two
 * separate renderers, each with its own copy of the module-singleton window store, so
 * the blob is the only thing that can carry a window between them.
 *
 * Restoring is not unconditional, because the blob describes the past. Between the save
 * and the restore the user may have opened one of those tasks somewhere else, and a
 * task's detail can only be open in one place (see
 * src/main/task-detail/detail-owner-registry.ts). Restoring it anyway would report
 * ownership main then has to resolve by DISPLACING the current owner - so simply
 * reopening the monitor would silently yank a task out of the board window the user is
 * working in.
 *
 * WHERE THIS ACTUALLY BITES: the MAIN WINDOW, which is the only renderer that mounts
 * `useRemoteDetailOwnersSync` and has a board layer, so it is the only one whose inputs
 * are ever non-empty. In a detached monitor both inputs are always empty and this
 * filter is inert - by design. There, displacement IS the mechanism: the pop-out
 * restores the layout, its report takes the detail from the in-app monitor, and main
 * tells that host to close. That is what carries an open detail across the detach,
 * verified live (ownership moves hosts with nobody clicking a row).
 *
 * So the filter is advisory, never authoritative: main still arbitrates, and an entry
 * this gets wrong degrades to a displacement rather than to a double-mounted terminal.
 * It exists to keep the monitor from stealing from the BOARD, not to police the
 * monitor's own two hosts.
 *
 * Pure, so the policy is unit-testable without a store or a DOM. Mirrors
 * `planCommandWindowReconciliation`, the same shape for the Command Terminal layer.
 */

import type { SerializedWorkspace } from '../../../shared/types';
import { parseMonitorAnchor } from '../../window-manager/store/monitor-anchor';

export interface MonitorWorkspaceRestoreInput {
  /** The saved layout, or null/undefined when nothing has been saved yet. */
  workspace: SerializedWorkspace | null | undefined;
  /** Task ids a detail window in ANOTHER renderer currently hosts
   *  (`session-store.remoteDetailTaskIds`, pushed by main). */
  ownedElsewhere: readonly string[];
  /** Task ids this renderer's BOARD layer currently hosts. Empty in a pop-out, which
   *  has no board. */
  boardTaskIds: readonly string[];
  /** Task ids with a RUNNING session right now. The monitor is where you watch working
   *  agents, so a saved entry only earns a restore while its agent is still there. */
  liveTaskIds: readonly string[];
}

export interface MonitorWorkspaceRestorePlan {
  /** Anchors (`projectId:taskId`) the monitor may restore. Feed to
   *  `applyWorkspace`'s `isKnownAnchor` predicate, which drops the rest AND prunes
   *  them from the tile tree. */
  restorableAnchors: Set<string>;
  /** Anchors dropped because the task is open somewhere else. Logged, not silent:
   *  a restore that quietly loses windows is indistinguishable from a broken save. */
  skippedAnchors: string[];
}

/**
 * Whether a host may write the shared layout blob right now.
 *
 * An empty window store means two different things, and only one is worth persisting:
 * "the user closed the last detail" (save it, or a deliberate close would be undone by
 * the next restore) versus "this host has not restored yet" (saving destroys the layout
 * it is about to read). A host earns the right to persist an empty layout by having
 * actually held a window.
 *
 * This is the invariant the whole cross-renderer handoff rests on, and it was found the
 * hard way: without it, detaching the monitor wiped the saved layout within ~1.5s -
 * before the pop-out could read it - so the detail vanished instead of following the
 * window.
 */
export function shouldPersistMonitorWorkspace(input: {
  windowCount: number;
  hasHeldWindows: boolean;
}): boolean {
  return input.windowCount > 0 || input.hasHeldWindows;
}

export function planMonitorWorkspaceRestore(
  input: MonitorWorkspaceRestoreInput,
): MonitorWorkspaceRestorePlan {
  const restorableAnchors = new Set<string>();
  const skippedAnchors: string[] = [];
  if (!input.workspace) return { restorableAnchors, skippedAnchors };

  const taken = new Set<string>([...input.ownedElsewhere, ...input.boardTaskIds]);
  const live = new Set(input.liveTaskIds);

  for (const savedWindow of input.workspace.windows) {
    // The persisted anchor lives in `taskId` (the field is the durable anchor for
    // every layer, whatever it happens to encode). For the monitor that is
    // `projectId:taskId`.
    const anchor = savedWindow.taskId;
    const parsed = parseMonitorAnchor(anchor);
    // Only task-detail windows belong in this layer. A malformed or foreign anchor
    // is dropped rather than restored into a window that could not resolve a task.
    if (!parsed || (savedWindow.kind !== undefined && savedWindow.kind !== 'task-detail')) {
      skippedAnchors.push(anchor);
      continue;
    }
    if (taken.has(parsed.taskId)) {
      skippedAnchors.push(anchor);
      continue;
    }
    // The agent is gone (finished, archived, or the task was deleted), so there is
    // nothing left to watch. Reported live: a task moved to Done and archived came
    // BACK on the next monitor open, because the layout remembered it and nothing
    // asked whether it was still worth showing.
    if (!live.has(parsed.taskId)) {
      skippedAnchors.push(anchor);
      continue;
    }
    restorableAnchors.add(anchor);
  }

  return { restorableAnchors, skippedAnchors };
}
