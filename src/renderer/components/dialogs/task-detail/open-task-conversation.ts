import { useSessionStore } from '../../../stores/session-store';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useToastStore } from '../../../stores/toast-store';
import { useWindowStore } from '../../../window-manager/store/window-store';
import { captureTerminalScrollback } from '../../../utils/terminal-capture-registry';
import { isLiveSessionStatus } from '../../../../shared/session-liveness';

/**
 * Open the conversation viewer for this task. The anchor session id only
 * resolves WHICH task to show (`transcripts.get` always returns that task's
 * entire lifecycle regardless of which of its sessions is passed), so any
 * session the task has a record of works. Shared by the header's Conversation
 * pill and the kebab "View conversation" item, so both open the same window.
 * A completed task shows its conversation in its own Conversation tab instead
 * (`completed/CompletedConversationTab.tsx`).
 *
 * "Already open" means the same TASK, not the same session: a window's anchor
 * is whichever session opened it (the task's registry session then, a search
 * hit's own session), so this looks for an open conversation window anchored
 * on any of the task's sessions and reuses its anchor, so a second open raises
 * that window instead of opening another for the same conversation. When
 * several match, the registry session's window wins, then the one raised
 * last. With none open it prefers the registry session, then the newest
 * listed one.
 *
 * The registry session is the task's row in the session store. A paused or
 * ended row the listing does not hold is dropped: after a restart it is a
 * placeholder with no record behind it. A running or queued row stays even
 * when unlisted.
 *
 * It asks for no tab: a new window shows All and an open one keeps the tab it
 * is on.
 *
 * `projectId` is passed in rather than read from the project store: this surface
 * can be hosted for a task in a project other than the open board's, and the
 * transcript lives in that project's DB.
 */
export async function openTaskConversation(taskId: string, projectId: string | null): Promise<void> {
  const registrySession = useSessionStore.getState()._sessionByTaskId.get(taskId) ?? null;
  let registrySessionId = registrySession?.id ?? null;
  // Capture the terminal's visible scrollback NOW, at click time, before the
  // async listSessions() gap below (during which live output could keep
  // scrolling it) - open-at-position needs the viewport exactly as the user
  // was looking at it. A no-terminal / no-live-session task simply has
  // nothing to capture (capture is null), and the viewer falls back to
  // opening at the bottom.
  const capture = captureTerminalScrollback(registrySessionId);
  let taskSessionIds: string[] = [];
  let newestSessionId: string | null = null;
  try {
    const list = await window.electronAPI.transcripts.listSessions(taskId, projectId);
    taskSessionIds = list.map((meta) => meta.sessionId);
    newestSessionId = [...list].sort((first, second) => second.startedAt.localeCompare(first.startedAt))[0]?.sessionId ?? null;
    // The list holds every session the task has a record of. A paused task's
    // registry row after a restart is a placeholder whose id has no record
    // (GitHub #822), so the viewer would find no task and no transcript.
    // Anchor on the list instead. A running or queued session is kept even
    // when unlisted: its record is written as it starts, and a click can
    // land just before that.
    if (registrySession && !taskSessionIds.includes(registrySession.id) && !isLiveSessionStatus(registrySession.status)) {
      registrySessionId = null;
    }
  } catch {
    // report-ok: the listing is only a check here, and main's IPC wrap
    // reports a handler that throws. With no list the row cannot be checked
    // against it, so the registry row is the anchor in any state, a paused
    // placeholder included.
  }
  const taskWindows = Object.values(useWindowStore.getState().windows).filter(
    (candidate) => candidate.kind === 'conversation' && (candidate.anchor === registrySessionId || taskSessionIds.includes(candidate.anchor)),
  );
  const reusedWindow = taskWindows.find((candidate) => candidate.anchor === registrySessionId)
    ?? taskWindows.reduce<(typeof taskWindows)[number] | null>(
      (raisedLast, candidate) => (raisedLast && raisedLast.zIndex >= candidate.zIndex ? raisedLast : candidate),
      null,
    );
  const sessionId = reusedWindow?.anchor ?? registrySessionId ?? newestSessionId;
  if (!sessionId) {
    useToastStore.getState().addToast({
      title: i18n._(msg`No conversation yet`),
      message: i18n._(msg`This task has no conversation history.`),
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
  useSessionStore.getState().setConversationSessionId(sessionId);
}
