import type { ConversationExpiredNotice } from '../../shared/types';
import { formatMonthDay } from './datetime';

/**
 * The toast for a task that started a new conversation because the agent had
 * deleted the one it would have resumed: what happened and from when, in one
 * sentence. The agent's recap carries the rest. A message the start held back
 * is left out: the agent summarizing instead of acting already shows it.
 */
export function describeConversationExpired(notice: ConversationExpiredNotice, now: Date = new Date()): string {
  const lastActive = notice.lastActiveAt ? formatMonthDay(notice.lastActiveAt, now) : '';
  const previous = lastActive ? `the one from ${lastActive}` : 'its previous one';
  return `"${notice.taskTitle}" started a new conversation because ${previous} expired.`;
}
