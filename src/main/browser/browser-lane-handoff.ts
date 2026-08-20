import { browserPaneRegistry, type BrowserPaneEntry, type PaneUnregisterReason } from './browser-pane-registry';
import { openLane, destroyHandoffLanesForTask, hasHandoffLaneForTask } from './browser-lane-manager';

/**
 * Keep an agent's browser alive when the user closes the task's window.
 *
 * The product rule this implements: a browser an agent is using belongs to the
 * AGENT, not to a piece of UI. The user must be free to close the task detail,
 * move around the board, and switch projects without disconnecting an agent
 * that is midway through verifying something.
 *
 * The mechanism it works around: an Electron `<webview>` guest dies the instant
 * its DOM node unmounts, so closing the task-detail window destroys the guest -
 * correctly, the node went away. Retention (see
 * `.claude/rules/retained-pane-never-remounts.md`) covers only the case where
 * the window STAYS OPEN across a project switch; it does nothing for a window
 * the user actually closed. Reproduced live, and the registry names it:
 *
 *   [browser-pane] unregister ... reason=guest-destroyed
 *
 * From there the agent was stuck: every drive returned `no-pane-open`, whose
 * hint says to call `open_pane`, which refused because the project was no longer
 * the open one.
 *
 * ## What happens instead
 *
 * When a user-visible pane closes while its task still has a live agent session,
 * main opens an offscreen LANE at the same URL and registers it under the same
 * task. The agent's next call resolves to it through the ordinary caller-task
 * rule, so nothing about the agent changes - it does not know a hand-off
 * happened, and does not need to.
 *
 * The user's close is still honoured: the window really closes and its renderer
 * surface really goes away. What survives is a headless browser the agent owns.
 *
 * ## Standing down
 *
 * When the user reopens that task's Browser pane, the hand-off lane is
 * destroyed. Two surfaces for one task would otherwise make every implicit call
 * ambiguous (`multiple-panes`), and the visible pane is the better answer
 * whenever it exists - the user can see it.
 *
 * Only AUTO-CREATED hand-off lanes stand down that way. A lane the agent asked
 * for with `isolated: true` is its own working surface and is never touched
 * here.
 */

export interface LaneHandoffDependencies {
  /** True when the task still has a live agent session worth preserving for. */
  hasLiveSession(taskId: string): boolean;
  /** The task's worktree directory, so the lane shares its cookie jar. */
  getTaskWorktreePath(taskId: string): string | null;
}

let dependencies: LaneHandoffDependencies | null = null;

/**
 * Reasons a pane closure is worth handing off.
 *
 * `self-heal-dead-guest` is deliberately excluded: it means the registry noticed
 * an entry pointing at a guest that was ALREADY gone, so there is nothing live
 * to preserve and re-opening would resurrect a browser nobody asked for.
 */
const HANDOFF_REASONS: ReadonlySet<PaneUnregisterReason> = new Set([
  'renderer-unmount',
  'renderer-unmount-matched',
  'guest-destroyed',
]);

function onPaneClosed(entry: BrowserPaneEntry, reason: PaneUnregisterReason): void {
  if (!dependencies) return;
  // Never hand off a lane. A lane closing is either the agent's own decision or
  // a cleanup path, and re-opening it would make lanes impossible to close.
  if (entry.kind === 'lane') return;
  if (!HANDOFF_REASONS.has(reason)) return;
  // Nothing to preserve: a pane on its empty state has no page to carry over.
  if (!entry.url) return;
  if (!entry.projectId) return;
  if (!dependencies.hasLiveSession(entry.taskId)) return;
  if (hasHandoffLaneForTask(entry.taskId)) return;

  const worktreePath = dependencies.getTaskWorktreePath(entry.taskId);

  void openLane({
    taskId: entry.taskId,
    projectId: entry.projectId,
    // Owned by the pane's session, so it dies with the agent it serves.
    ownerSessionId: entry.sessionId,
    cwd: worktreePath,
    url: entry.url,
    handoff: true,
  })
    .then((result) => {
      if (result.ok) {
        console.log(
          `[browser-pane] handoff task=${entry.taskId.slice(0, 8)} url=${entry.url} lane=${result.laneId} ` +
            '(window closed, agent keeps its browser)',
        );
      } else {
        console.warn(`[browser-pane] handoff failed for task=${entry.taskId.slice(0, 8)}: ${result.detail}`);
      }
    })
    .catch((error: unknown) => {
      console.warn(`[browser-pane] handoff threw for task=${entry.taskId.slice(0, 8)}:`, error);
    });
}

function onPaneRegistered(entry: BrowserPaneEntry): void {
  // The user's own pane is back, so the stand-in is no longer the best answer -
  // and keeping both would make every implicit call ambiguous.
  if (entry.kind === 'lane') return;
  const destroyed = destroyHandoffLanesForTask(entry.taskId);
  if (destroyed > 0) {
    console.log(
      `[browser-pane] handoff ended task=${entry.taskId.slice(0, 8)} ` +
        `(${destroyed} lane(s) closed, the visible pane is back)`,
    );
  }
}

/** Wire the hand-off. Called once at startup. */
export function installLaneHandoff(deps: LaneHandoffDependencies): void {
  dependencies = deps;
  browserPaneRegistry.setPaneClosedHandler(onPaneClosed);
  browserPaneRegistry.setPaneRegisteredHandler(onPaneRegistered);
}

/** Test seam. */
export function uninstallLaneHandoff(): void {
  dependencies = null;
  browserPaneRegistry.setPaneClosedHandler(null);
  browserPaneRegistry.setPaneRegisteredHandler(null);
}
