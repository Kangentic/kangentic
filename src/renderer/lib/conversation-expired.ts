import type { ConversationExpiredNotice } from '../../shared/types';
import { formatMonthDay } from './datetime';

/**
 * The toast for a task that started a new conversation because the agent had
 * deleted the one it would have resumed: what happened, from when, and whether
 * the message it was resuming with went out. The agent's recap carries the
 * rest, so the toast stays one or two short sentences.
 */
export function describeConversationExpired(notice: ConversationExpiredNotice, now: Date = new Date()): string {
  const lastActive = notice.lastActiveAt ? formatMonthDay(notice.lastActiveAt, now) : '';
  const sentences = [
    `"${notice.taskTitle}" started a new conversation.`,
    lastActive ? `The one from ${lastActive} had expired.` : 'Its previous one had expired.',
  ];
  if (notice.messageDropped) sentences.push('Its pending message was not sent.');
  return sentences.join(' ');
}
