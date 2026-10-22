import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { describeConversationExpired } from '../../src/renderer/lib/conversation-expired';
import { __setLocaleForTests } from '../../src/renderer/lib/datetime';
import type { ConversationExpiredNotice } from '../../src/shared/types';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function notice(overrides: Partial<ConversationExpiredNotice> = {}): ConversationExpiredNotice {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    taskTitle: 'Fix login redirect',
    lastActiveAt: '2026-08-16T14:00:00.000Z',
    ...overrides,
  };
}

describe('describeConversationExpired', () => {
  beforeEach(() => __setLocaleForTests('en-US'));
  afterEach(() => __setLocaleForTests(undefined));

  it('names the task and when its old conversation last ran, in one sentence', () => {
    expect(describeConversationExpired(notice(), NOW)).toBe(
      '"Fix login redirect" started fresh because its conversation from Aug 16 expired.',
    );
  });

  it('reads cleanly with no date', () => {
    expect(describeConversationExpired(notice({ lastActiveAt: null }), NOW)).toBe(
      '"Fix login redirect" started fresh because its last conversation expired.',
    );
  });
});
