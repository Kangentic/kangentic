/**
 * Open a conversation on the Knowledge Graph's OWN window layer.
 *
 * Deliberately not `session-store.setConversationSessionId`, which is the board's
 * signal: its bridge mounts the window on the board layer at z-40, underneath the
 * graph's z-42 overlay, and in a detached graph there is no board layer to mount
 * on at all. See `KnowledgeGraphDetailLayer` for the full story.
 *
 * A leaf module rather than an export of the layer, so the lazily-loaded graph
 * body reaches this without importing the layer component itself.
 *
 * Writing straight to the store (instead of adding a second bridge on the shared
 * signal) is what keeps this unambiguous: one signal with two bridges would open
 * the transcript in BOTH layers at once.
 */

import { knowledgeGraphWindowManager } from '../../window-manager';

/**
 * Which project this layer's open windows belong to.
 *
 * A conversation window anchors on a SESSION id, which carries no project, and
 * `ConversationWindow` refetches whenever the ambient project changes - so a window
 * left open across a project switch silently refetches session A against project B,
 * finds nothing, and blanks to "(unknown task)". The board hits the same problem and
 * solves it by closing its conversation windows on switch
 * (`useProjectSwitchEffect`); this is the same fix for this layer, which that effect
 * does not reach (and which also has to work in a pop-out, where that effect is not
 * mounted at all).
 *
 * Module scope because the window store deliberately outlives the layer, so the
 * stamp has to outlive it too. Preserved across HMR (Pattern A) so a Fast Refresh
 * mid-session does not orphan the stamp and close a window the user is reading.
 */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let windowsProjectId: string | null = import.meta.hot?.data?.knowledgeGraphConversationProjectId ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
import.meta.hot?.dispose((data: Record<string, unknown>) => {
  data.knowledgeGraphConversationProjectId = windowsProjectId;
});

/**
 * Open, or focus, a window for `sessionId` in `projectId`.
 *
 * Dedupe-by-anchor mirrors `useConversationWindowBridge`: re-opening the same
 * conversation focuses the window that is already showing it instead of stacking a
 * duplicate. Opening a DIFFERENT one still opens a second window, also matching the
 * board - and it earns its keep here, since the detail panel's whole point is
 * pointing at closely related conversations worth reading side by side.
 */
export function openKnowledgeGraphConversation(
  sessionId: string,
  projectId: string | null,
  /** Open at this turn: the passage a chat answer used. */
  turnUuid?: string | null,
  /**
   * The project this conversation belongs to, when the map shows several and
   * it is not the open one. Stamped on the window, so it reads the transcript
   * from its own project.
   */
  conversationProjectId?: string | null,
): void {
  const store = knowledgeGraphWindowManager.store.getState();
  windowsProjectId = projectId;

  // `openWindow` focuses (and re-aims) an existing window for the anchor rather
  // than stacking a duplicate.
  store.openWindow({
    kind: 'conversation',
    anchor: sessionId,
    sessionId,
    title: 'Conversation',
    ...(turnUuid ? { scrollToTurnUuid: turnUuid } : {}),
    ...(conversationProjectId && conversationProjectId !== projectId ? { projectId: conversationProjectId } : {}),
  });
}

/**
 * Close every window on this layer if it belongs to a different project than
 * `projectId`. Called whenever the graph re-points, in either host.
 *
 * Nothing is persisted for this layer, so there is nothing to capture first - unlike
 * the board, which must serialize the outgoing project's workspace before closing.
 */
export function closeKnowledgeGraphConversationsForOtherProject(projectId: string | null): void {
  if (projectId === null || windowsProjectId === null || windowsProjectId === projectId) return;
  const store = knowledgeGraphWindowManager.store.getState();
  for (const managedWindow of Object.values(store.windows)) {
    store.closeWindow(managedWindow.id);
  }
  windowsProjectId = projectId;
}
