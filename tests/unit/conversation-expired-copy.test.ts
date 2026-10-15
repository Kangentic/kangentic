import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { describeConversationExpired, describeConversationsExpired } from '../../src/renderer/lib/conversation-expired';
import { __setLocaleForTests } from '../../src/renderer/lib/datetime';
import type { ConversationExpiredNotice } from '../../src/shared/types';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function notice(overrides: Partial<ConversationExpiredNotice> = {}): ConversationExpiredNotice {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    taskTitle: 'Fix login redirect',
    lastActiveAt: '2026-08-16T14:00:00.000Z',
    messageDropped: false,
    ...overrides,
  };
}

describe('describeConversationExpired', () => {
  beforeEach(() => __setLocaleForTests('en-US'));
  afterEach(() => __setLocaleForTests(undefined));

  it('names the task and when its old conversation last ran', () => {
    expect(describeConversationExpired(notice(), NOW)).toBe(
      '"Fix login redirect" started a new conversation. The one from Aug 16 had expired.',
    );
  });

  it('says so when the message the resume carried was not sent', () => {
    expect(describeConversationExpired(notice({ messageDropped: true }), NOW)).toBe(
      '"Fix login redirect" started a new conversation. The one from Aug 16 had expired. Its pending message was not sent.',
    );
  });

  it('reads cleanly with no date', () => {
    expect(describeConversationExpired(notice({ lastActiveAt: null }), NOW)).toBe(
      '"Fix login redirect" started a new conversation. Its previous one had expired.',
    );
  });
});

// A user back after the agent's cleanup period finds every suspended task
// expired at once, so several notices make one toast with counts.
describe('describeConversationsExpired', () => {
  beforeEach(() => __setLocaleForTests('en-US'));
  afterEach(() => __setLocaleForTests(undefined));

  it('words a single notice as describeConversationExpired does', () => {
    expect(describeConversationsExpired([notice({ messageDropped: true })], NOW)).toBe(
      describeConversationExpired(notice({ messageDropped: true }), NOW),
    );
  });

  it('counts several tasks in one sentence', () => {
    const notices = [notice(), notice({ taskId: 'task-2' }), notice({ taskId: 'task-3' })];
    expect(describeConversationsExpired(notices, NOW)).toBe(
      '3 tasks started a new conversation because their previous ones had expired.',
    );
  });

  it('counts the pending messages that were not sent', () => {
    const oneDropped = [notice({ messageDropped: true }), notice({ taskId: 'task-2' })];
    expect(describeConversationsExpired(oneDropped, NOW)).toBe(
      '2 tasks started a new conversation because their previous ones had expired. 1 pending message was not sent.',
    );
    const twoDropped = [notice({ messageDropped: true }), notice({ taskId: 'task-2', messageDropped: true })];
    expect(describeConversationsExpired(twoDropped, NOW)).toBe(
      '2 tasks started a new conversation because their previous ones had expired. 2 pending messages were not sent.',
    );
  });
});
