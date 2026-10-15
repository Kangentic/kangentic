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

/**
 * One toast for every notice taken at once. A user back after the agent's
 * cleanup period finds every suspended task expired on the same launch, so
 * several notices become one toast with counts rather than one toast per task.
 */
export function describeConversationsExpired(notices: readonly ConversationExpiredNotice[], now: Date = new Date()): string {
  if (notices.length === 1) return describeConversationExpired(notices[0], now);
  const sentences = [`${notices.length} tasks started a new conversation because their previous ones had expired.`];
  const droppedCount = notices.filter((notice) => notice.messageDropped).length;
  if (droppedCount === 1) sentences.push('1 pending message was not sent.');
  if (droppedCount > 1) sentences.push(`${droppedCount} pending messages were not sent.`);
  return sentences.join(' ');
}
