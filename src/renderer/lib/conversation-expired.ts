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
  const previous = lastActive ? `its conversation from ${lastActive}` : 'its last conversation';
  return `"${notice.taskTitle}" started fresh because ${previous} expired.`;
}
