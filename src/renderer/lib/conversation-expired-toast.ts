import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { ConversationExpiredNotice } from '../../shared/types';
import { useProjectStore } from '../stores/project-store';
import { useToastStore } from '../stores/toast-store';
import { openTaskFromNotification } from '../utils/open-task-from-notification';
import { describeConversationExpired } from './conversation-expired';

/**
 * Take a project's queued expired-conversation notices from main and toast
 * them. Called on the `task:conversationExpired` push for the current project
 * and whenever a project becomes current: startup recovery reports before the
 * renderer can take a push, so main holds each notice until one of these asks
 * (`pending-conversation-expired.ts`). Main hands each notice out once, so the
 * two callers never toast the same one.
 *
 * Kept apart from `conversation-expired.ts` so the copy stays importable by the
 * unit tier without the toast store. Not named `load*`: the HMR re-sync calls
 * every `load*` method, which here would only spend the queue.
 */
export async function showConversationExpiredNotices(projectId: string): Promise<void> {
  const takeConversationExpired = window.electronAPI.tasks?.takeConversationExpired;
  if (!takeConversationExpired) return;
  let notices: ConversationExpiredNotice[];
  try {
    notices = await takeConversationExpired(projectId);
  } catch (error) {
    // Swallowed, not reported: the toast is advisory, and the agent's own
    // recap already says the conversation started over.
    console.warn('[CONVERSATION-EXPIRED] Could not take queued notices:', error);
    return;
  }
  if (notices.length === 0) return;
  // The user switched projects while the take was in flight. These name tasks
  // of a board no longer on screen, so they are dropped rather than toasted
  // over another project's board.
  if (useProjectStore.getState().currentProject?.id !== projectId) return;
  // One toast per task. Info, not a warning: nothing failed, and each agent is
  // already summarizing where its work stands. The toast store's own limit
  // drops the oldest when a launch finds many tasks expired at once. The card
  // opens the task, where the agent's recap is.
  for (const notice of notices) {
    useToastStore.getState().addToast({
      title: i18n._(msg`New conversation`),
      message: describeConversationExpired(notice),
      variant: 'info',
      durationMs: 12000,
      onOpen: () => openTaskFromNotification(notice.projectId, notice.taskId),
    });
  }
}
