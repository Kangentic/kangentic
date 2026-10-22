import { useSessionStore } from '../../../stores/session-store';
import { useToastStore } from '../../../stores/toast-store';
import { useWindowStore } from '../../../window-manager/store/window-store';
import { captureTerminalScrollback } from '../../../utils/terminal-capture-registry';
import type { ConversationTabRequest } from '../../../../shared/types';

/**
 * Open the conversation viewer for this task. The anchor session id only
 * resolves WHICH task to show (`transcripts.get` always returns that task's
 * entire lifecycle regardless of which of its sessions is passed), so any
 * valid session id works. Shared by the header's Conversation pill, the kebab
 * "View conversation" item, the completed task view's tab bar, its Route card
 * (a column pill or a repeat-stay row, which pass a `target`), and the archived
 * card's right-click menu, so all of them open the same window.
 *
 * "Already open" means the same TASK, not the same session: a window's anchor
 * is whichever session opened it (the live one then, a search hit's own
 * session), so this looks for an open conversation window anchored on any of
 * the task's sessions and reuses its anchor. A Route pill then switches that
 * window's tab instead of opening a second window for the same conversation.
 * When several match, the live session's window wins, then the one raised
 * last. With none open it prefers the live session, then the newest.
 *
 * A `target` shows that column's tab, scrolled to the stay when
 * `visitStartedAt` names one. With no `target` a new window shows All and an
 * open one keeps the tab it is on.
 *
 * `projectId` is passed in rather than read from the project store: this surface
 * can be hosted for a task in a project other than the open board's, and the
 * transcript lives in that project's DB.
 */
export async function openTaskConversation(taskId: string, projectId: string | null, target?: ConversationTabRequest): Promise<void> {
  const liveSessionId = useSessionStore.getState()._sessionByTaskId.get(taskId)?.id ?? null;
  // Capture the terminal's visible scrollback NOW, at click time, before the
  // async listSessions() gap below (during which live output could keep
  // scrolling it) - open-at-position needs the viewport exactly as the user
  // was looking at it. A no-terminal / no-live-session task simply has
  // nothing to capture (capture is null), and the viewer falls back to
  // opening at the bottom. A column target opens at its own position, so it
  // takes no capture.
  const capture = target ? null : captureTerminalScrollback(liveSessionId);
  let taskSessionIds: string[] = [];
  let newestSessionId: string | null = null;
  try {
    const list = await window.electronAPI.transcripts.listSessions(taskId, projectId);
    taskSessionIds = list.map((meta) => meta.sessionId);
    newestSessionId = [...list].sort((first, second) => second.startedAt.localeCompare(first.startedAt))[0]?.sessionId ?? null;
  } catch {
    // No list: fall back to the live session alone, as before.
  }
  const taskWindows = Object.values(useWindowStore.getState().windows).filter(
    (candidate) => candidate.kind === 'conversation' && (candidate.anchor === liveSessionId || taskSessionIds.includes(candidate.anchor)),
  );
  const reusedWindow = taskWindows.find((candidate) => candidate.anchor === liveSessionId)
    ?? taskWindows.reduce<(typeof taskWindows)[number] | null>(
      (raisedLast, candidate) => (raisedLast && raisedLast.zIndex >= candidate.zIndex ? raisedLast : candidate),
      null,
    );
  const sessionId = reusedWindow?.anchor ?? liveSessionId ?? newestSessionId;
  if (!sessionId) {
    useToastStore.getState().addToast({
      title: 'No conversation yet',
      message: 'This task has no conversation history.',
      variant: 'info',
    });
    return;
  }
  if (capture) {
    useSessionStore.getState().setPendingTuiAnchor({
      sessionId,
      visibleLines: capture.visibleLines,
      atBottom: capture.atBottom,
    });
  }
  useSessionStore.getState().setConversationSessionId(sessionId, target ?? null);
}
