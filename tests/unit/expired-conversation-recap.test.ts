/**
 * The opening prompt of a session started in place of a resume whose
 * conversation the agent deleted. It rides the command line, so it must stay
 * under the inline budget whatever its sources return, and it must never lose
 * the closing instruction: the user chose "summarize, then wait" for a task old
 * enough for its conversation to expire.
 */
import { describe, it, expect } from 'vitest';
import {
  buildExpiredConversationRecap,
  type ExpiredConversationRecapInput,
} from '../../src/main/agent/shared/expired-conversation-recap';
import { formatConversationTail } from '../../src/main/agent/shared/conversation-tail';
import { INLINE_PROMPT_BUDGET } from '../../src/main/agent/shared/prompt-budget';
import type { TranscriptEntry } from '../../src/shared/types';

function input(overrides: Partial<ExpiredConversationRecapInput> = {}): ExpiredConversationRecapInput {
  return {
    task: { id: 'task-1', title: 'Fix login redirect', description: 'Users land on /home after login.', pr_url: null },
    agentDisplayName: 'Claude Code',
    previousAgentSessionId: 'aaaaaaaa-1111-4222-8333-444444444444',
    lastActiveAt: '2026-08-16T14:00:00.000Z',
    cwd: '/mock/worktree',
    baseBranch: 'main',
    mode: 'whole-prompt',
    ...overrides,
  };
}

const CLOSING = 'Reply with a short summary of where the work stands, then wait for the user\'s next instruction.';

describe('buildExpiredConversationRecap', () => {
  it('says what happened, carries the task, points at the old conversation, and ends on summarize-then-wait', async () => {
    const recap = await buildExpiredConversationRecap(input());
    expect(recap).toContain('last active on 2026-08-16');
    expect(recap).toContain('Claude Code deleted it after its retention period');
    expect(recap).toContain('<title>Fix login redirect</title>');
    // By the OLD conversation's id: a call by task id would read the newest
    // session, which is the new one.
    expect(recap).toContain('kangentic_get_transcript tool, passing sessionId aaaaaaaa-1111-4222-8333-444444444444.');
    expect(recap.endsWith(CLOSING)).toBe(true);
  });

  it('in context mode, carries neither the task nor the wait: the column prompt has both jobs', async () => {
    const recap = await buildExpiredConversationRecap(input({ mode: 'context' }));
    expect(recap).not.toContain('<task>');
    expect(recap).not.toContain('then wait');
    expect(recap).toContain('for context');
  });

  it('includes each source that answered, escaped', async () => {
    const recap = await buildExpiredConversationRecap(input({ task: { id: 'task-1', title: 'Fix login', description: '', pr_url: 'https://example.test/pr/12' } }), {
      readTaskSummary: async () => 'Moved the redirect into <AuthGate>.',
      readConversationTail: async () => 'User: does it work?\n\nAgent: Yes, tests pass.',
      readGitState: async () => ({ branch: 'fix-login', commits: ['abc1234 Move redirect'], changes: [' M src/auth.ts'] }),
    });
    expect(recap).toContain('<task_summary>\nMoved the redirect into &lt;AuthGate&gt;.\n</task_summary>');
    expect(recap).toContain('<previous_conversation_tail>\nUser: does it work?');
    expect(recap).toContain('Branch: fix-login, based on main');
    expect(recap).toContain('Pull request: https://example.test/pr/12');
    expect(recap).toContain('abc1234 Move redirect');
    expect(recap).toContain('Uncommitted changes:\n M src/auth.ts');
  });

  it('skips a source that fails or answers nothing, and still builds', async () => {
    const recap = await buildExpiredConversationRecap(input(), {
      readTaskSummary: async () => { throw new Error('worker down'); },
      readConversationTail: async () => null,
      readGitState: async () => null,
    });
    expect(recap).not.toContain('<task_summary>');
    expect(recap).not.toContain('<previous_conversation_tail>');
    expect(recap).not.toContain('<branch_state>');
    expect(recap.endsWith(CLOSING)).toBe(true);
  });

  it('gives the tail only the room the rest leaves, and asks for no more', async () => {
    let askedFor = 0;
    const recap = await buildExpiredConversationRecap(input(), {
      readConversationTail: async (_agentSessionId, maxChars) => {
        askedFor = maxChars;
        return 'x'.repeat(maxChars);
      },
    });
    expect(askedFor).toBeGreaterThan(0);
    expect(askedFor).toBeLessThan(INLINE_PROMPT_BUDGET);
    expect(recap.length).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    expect(recap.endsWith(CLOSING)).toBe(true);
  });

  it('stays under the budget with a description full of characters escaping lengthens', async () => {
    const recap = await buildExpiredConversationRecap(input({
      task: { id: 'task-1', title: 'Escapes', description: '&'.repeat(5_000), pr_url: null },
    }), {
      readConversationTail: async (_agentSessionId, maxChars) => '<'.repeat(maxChars),
      readTaskSummary: async () => '&'.repeat(360),
    });
    expect(recap.length).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    expect(recap.endsWith(CLOSING)).toBe(true);
  });

  it('names no date when the old conversation has none', async () => {
    const recap = await buildExpiredConversationRecap(input({ lastActiveAt: null }));
    expect(recap.startsWith('You had a previous conversation on this task.')).toBe(true);
  });
});

describe('formatConversationTail', () => {
  const entries: TranscriptEntry[] = [
    { kind: 'user', uuid: 'u1', ts: 1, text: 'First ask' },
    { kind: 'assistant', uuid: 'a1', ts: 2, blocks: [{ type: 'thinking', text: 'hidden' }, { type: 'text', text: 'First answer' }] },
    { kind: 'tool_result', uuid: 't1', ts: 3, toolUseId: 'x', content: 'tool output' },
    { kind: 'assistant', uuid: 'a2', ts: 4, blocks: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] },
    { kind: 'user', uuid: 'u2', ts: 5, text: 'Second ask' },
    { kind: 'assistant', uuid: 'a3', ts: 6, blocks: [{ type: 'text', text: 'Second answer' }] },
  ];

  it('keeps user messages and agent prose in reading order, and drops tools and thinking', () => {
    expect(formatConversationTail(entries, 10_000)).toBe(
      'User: First ask\n\nAgent: First answer\n\nUser: Second ask\n\nAgent: Second answer',
    );
  });

  it('keeps the newest turns when the room runs out', () => {
    expect(formatConversationTail(entries, 40)).toBe('User: Second ask\n\nAgent: Second answer');
  });

  it('keeps the end of a single turn longer than the room', () => {
    const tail = formatConversationTail([{ kind: 'user', uuid: 'u', ts: 1, text: 'a'.repeat(500) }], 50);
    expect(tail?.length).toBe(50);
    expect(tail?.startsWith('...')).toBe(true);
  });

  it('answers null when there is nothing to say', () => {
    expect(formatConversationTail([], 1_000)).toBeNull();
    expect(formatConversationTail(entries, 0)).toBeNull();
  });
});
