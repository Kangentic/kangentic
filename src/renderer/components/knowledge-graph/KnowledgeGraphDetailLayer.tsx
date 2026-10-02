/**
 * The Knowledge Graph's conversation window layer: the SAME `ConversationWindow` the
 * board hosts, mounted OVER the graph in whichever host the user is looking at.
 *
 * This exists because of a reported bug. "Open conversation" used to write
 * `session-store.conversationSessionId`, which the BOARD's bridge turns into a
 * window on the board layer at z-40 - underneath the graph's own z-42 overlay. The
 * transcript opened correctly and was completely invisible. Detached, it was worse
 * than misplaced: a pop-out is a separate renderer with no board layer at all, so
 * the signal had no destination.
 *
 * The fix mirrors `MonitorDetailLayer`: the surface hosts its own window layer, and
 * BOTH hosts (the in-app overlay and the detached root) mount it. That is the only
 * shape that works in a pop-out, because it stops routing through a layer that
 * exists in exactly one of the two renderers.
 *
 * Three things it deliberately does NOT do, each of which the monitor does:
 *
 *  - **No workspace persistence.** A watched agent's task detail is meant to
 *    survive; a transcript is something you opened to read once. Persisting it
 *    would restore a conversation nobody asked for on the next open.
 *  - **No detail-ownership reporting.** Ownership arbitrates task details, which
 *    can only be open in one place because two windows would put two xterms on one
 *    PTY. A transcript is read-only, so two viewers are harmless - and
 *    `useDetailOwnershipSync`, `useWindowSessionClaims`, and
 *    `useWindowAutoCloseOnDone` all skip non-task-detail windows already, so this
 *    layer adds no coupling to any of them.
 *  - **No `renderTaskDetail`, and `revealTaskDetail` only in-app.** It hosts no
 *    task details. In-app, "Open task" CLOSES the graph and then reveals the task
 *    on the board, which is where a task detail lives; the host supplies that
 *    through `onRevealTask`. The detached window supplies nothing, which hides the
 *    button: there is no board in a pop-out to reveal a task on, and a reveal
 *    that did nothing would be worse than no button.
 */

import { useEffect, useMemo } from 'react';
import { knowledgeGraphWindowManager, WindowManagerLayer } from '../../window-manager';
import type { WindowManagerLayerOptions } from '../../window-manager';
import { DEFAULT_MIN_WIDTH_PX, DEFAULT_MIN_HEIGHT_PX } from '../../window-manager/dnd/useWindowResize';
import { useClickOutsideToClose } from '../../window-manager/bridge/useClickOutsideToClose';
import { useKnowledgeGraphStore } from '../../stores/knowledge-graph-store';
import { closeKnowledgeGraphConversationsForOtherProject } from './open-knowledge-graph-conversation';

function KnowledgeGraphDetailBridge(): null {
  // Light dismiss, matching the board and the monitor: a click on empty space
  // outside a window closes it per the user's "Close on Outside Click" setting.
  // The `knowledge-graph` scope binds this instance to the graph's own `data-dismiss-layer`
  // subtree AND to this window store, so it closes THESE windows rather than the
  // board's underneath. The canvas is exempt (it carries `data-no-dismiss` for its
  // grab cursor), so panning the map never closes a transcript.
  useClickOutsideToClose('knowledge-graph');

  /**
   * Drop conversations belonging to a project the graph has moved off.
   *
   * Keyed on the snapshot's RESOLVED project id rather than on the project store,
   * because that is the one signal both hosts share: a pop-out's project store is
   * never populated (it follows main by passing null and letting main resolve), so
   * a project-store subscription would be dead code there - the same trap that made
   * an earlier pop-out project-switch subscription do nothing.
   */
  const snapshotProjectId = useKnowledgeGraphStore((state) => state.snapshot?.projectId ?? null);
  useEffect(() => {
    closeKnowledgeGraphConversationsForOtherProject(snapshotProjectId);
  }, [snapshotProjectId]);

  return null;
}

interface KnowledgeGraphDetailLayerProps {
  /**
   * Bottom inset, supplied by the host rather than hardcoded. In-app the status
   * bar occupies the last 36px (and can be hidden); a detached window has no
   * status bar, so its layer runs to the frame's bottom edge.
   */
  bottomInsetClass: string;
  /** How "Open task" reaches the board, or absent where there is no board. The
   *  project is set for a task outside the open one. */
  onRevealTask?: (taskId: string, projectId?: string) => void;
}

export function KnowledgeGraphDetailLayer({ bottomInsetClass, onRevealTask }: KnowledgeGraphDetailLayerProps) {
  const layerOptions = useMemo<WindowManagerLayerOptions>(() => ({
    minSize: { width: DEFAULT_MIN_WIDTH_PX, height: DEFAULT_MIN_HEIGHT_PX },
    ...(onRevealTask ? { revealTaskDetail: onRevealTask } : {}),
  }), [onRevealTask]);
  return (
    <WindowManagerLayer
      manager={knowledgeGraphWindowManager}
      layer={layerOptions}
      portalHostId="knowledge-graph-detail-layer-root"
      overlayTestId="knowledge-graph-detail-overlay"
      // Sits above the graph (z-42) and below the Command Terminal layer (z-45),
      // which the graph already hides on open - the same slot the monitor's detail
      // layer uses. `pointer-events-none` so the map stays pannable in the gaps
      // between windows, exactly like the board layer over the board.
      overlayClassName={`fixed left-0 right-0 top-10 ${bottomInsetClass} z-[43] pointer-events-none`}
      bridges={<KnowledgeGraphDetailBridge />}
    />
  );
}
