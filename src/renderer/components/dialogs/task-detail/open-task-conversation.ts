import { useSessionStore } from '../../../stores/session-store';
import { useToastStore } from '../../../stores/toast-store';
import { captureTerminalScrollback } from '../../../utils/terminal-capture-registry';

/**
 * Open the conversation viewer for this task. The anchor session id only
 * resolves WHICH task to show (`transcripts.get` always returns that task's
 * entire lifecycle regardless of which of its sessions is passed), so any
 * valid session id works - prefer the live one (readily available), otherwise
 * resolve the newest via listSessions. Shared by the header's Conversation
 * pill, the kebab "View conversation" item, and the completed task view's
 * tab bar, so all three open the same window.
 *
 * `projectId` is passed in rather than read from the project store: this surface
 * can be hosted for a task in a project other than the open board's, and the
 * transcript lives in that project's DB.
 */
export async function openTaskConversation(taskId: string, projectId: string | null): Promise<void> {
  let sessionId = useSessionStore.getState()._sessionByTaskId.get(taskId)?.id ?? null;
  // Capture the terminal's visible scrollback NOW, at click time, before the
  // async listSessions() gap below (during which live output could keep
  // scrolling it) - open-at-position needs the viewport exactly as the user
  // was looking at it. A no-terminal / no-live-session task simply has
  // nothing to capture (capture is null), and the viewer falls back to
  // opening at the bottom.
  const capture = captureTerminalScrollback(sessionId);
  if (!sessionId) {
    try {
      const list = await window.electronAPI.transcripts.listSessions(taskId, projectId);
      const newest = [...list].sort((first, second) => second.startedAt.localeCompare(first.startedAt))[0];
      sessionId = newest?.sessionId ?? null;
    } catch {
      sessionId = null;
    }
  }
  if (sessionId) {
    if (capture) {
      useSessionStore.getState().setPendingTuiAnchor({
        sessionId,
        visibleLines: capture.visibleLines,
        atBottom: capture.atBottom,
      });
    }
    useSessionStore.getState().setConversationSessionId(sessionId);
  } else {
    useToastStore.getState().addToast({ message: 'No conversation history for this task yet', variant: 'info' });
  }
}
