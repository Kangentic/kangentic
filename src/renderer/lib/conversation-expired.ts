import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { ConversationExpiredNotice } from '../../shared/types';
import { formatMonthDay } from './datetime';

/**
 * The body of the "New conversation" toast, for a task that started fresh
 * because the agent had deleted the conversation it would have resumed: which
 * task, and from when, in one sentence. The title already says a new
 * conversation started, so the body does not repeat it. The agent's recap
 * carries the rest. A message the start held back is left out: the agent
 * summarizing instead of acting already shows it.
 */
export function describeConversationExpired(notice: ConversationExpiredNotice, now: Date = new Date()): string {
  const lastActive = notice.lastActiveAt ? formatMonthDay(notice.lastActiveAt, now) : '';
  const taskTitle = notice.taskTitle;
  return lastActive
    ? i18n._(msg`"${{ taskTitle }}" started fresh because its conversation from ${{ lastActive }} expired.`)
    : i18n._(msg`"${{ taskTitle }}" started fresh because its last conversation expired.`);
}
