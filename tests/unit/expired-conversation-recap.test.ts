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

const CLOSING = 'Reply with a short summary of where the work stands, then wait for the next instruction from the user.';

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

describe('the branch block', () => {
  it('is left out entirely when even its first line is longer than the 1,400 characters the block holds', async () => {
    // A branch name of 1,500 characters makes the first line (`Branch: ...`)
    // alone too long. A block with no lines would cost room and say nothing, so
    // there is no block at all, not an empty `<branch_state>` pair.
    const longBranch = 'q'.repeat(1_500);
    const recap = await buildExpiredConversationRecap(input(), {
      readGitState: async () => ({ branch: longBranch, commits: ['abc1234 Move redirect'], changes: [' M src/auth.ts'] }),
    });

    expect(recap.includes('<branch_state>')).toBe(false);
    expect(recap.includes('</branch_state>')).toBe(false);
    // None of the branch's characters leaked in some other shape.
    expect(recap.includes('qqqqqqqqqq')).toBe(false);
    expect(recap.endsWith(CLOSING)).toBe(true);

    // Control: a branch name that leaves the first line inside the cap gives the
    // block, so the absence above comes from the cap and not from the source.
    const shortEnough = await buildExpiredConversationRecap(input(), {
      readGitState: async () => ({ branch: 'q'.repeat(1_300), commits: [], changes: [] }),
    });
    expect(shortEnough.includes('<branch_state>\nBranch: qqqq')).toBe(true);
  });
});

describe('control characters in the text the recap did not write', () => {
  // Typed into the spawning shell, so an escape from a pasted terminal log, a
  // Ctrl+C, a bare carriage return (which is Enter) and a tab (which completes,
  // even inside quotes) must not reach it. Line breaks stay.
  const DIRTY_TEXT = 'a\tb \x1b[31mred\x1b[0m c\x03d e\rf g\x7fh i\u009bj k\r\nl café \u{1F642}';
  const CLEAN_TEXT = 'a b [31mred[0m cd ef gh ij k\nl café \u{1F642}';

  /** The distinct control characters in `text`: C0, DEL and C1 (0x80 to 0x9F). */
  function controlCodesIn(text: string): number[] {
    const codes = new Set<number>();
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) codes.add(code);
    }
    return [...codes];
  }

  it('drops every control character but the line break, turns a tab into a space, and keeps the words around them', async () => {
    const recap = await buildExpiredConversationRecap(input(), {
      readTaskSummary: async () => `Summary ${DIRTY_TEXT}`,
      readConversationTail: async () => `User: ${DIRTY_TEXT}`,
    });

    // Both blocks went in, so the scan below covers them.
    expect(recap.includes('<task_summary>')).toBe(true);
    expect(recap.includes('<previous_conversation_tail>')).toBe(true);
    // The only control character anywhere in the recap is the line break.
    expect(controlCodesIn(recap)).toEqual([0x0a]);
    for (const dropped of ['\t', '\x1b', '\x03', '\r', '\x7f', '\u009b']) {
      expect(recap.includes(dropped)).toBe(false);
    }
    // Each piece reads as its clean form: tab to a space, CRLF to a line break,
    // other controls gone with their neighbours joined, text above 0x9F kept.
    expect(recap.includes(`<task_summary>\nSummary ${CLEAN_TEXT}\n</task_summary>`)).toBe(true);
    expect(recap.includes(`<previous_conversation_tail>\nUser: ${CLEAN_TEXT}\n</previous_conversation_tail>`)).toBe(true);
    expect(recap.endsWith(CLOSING)).toBe(true);
  });

  // The git state and the task are text the recap did not write either: a
  // commit subject is anyone's, git keeps a tab or an escape in it, and the
  // task may be imported from a tracker. Each piece is pinned by its own test
  // so that a filter dropped from one place fails only that place's test.
  // The dirt carries a tab, a bare carriage return (Enter), an escape sequence
  // and a Ctrl+C, and no CRLF, so the only line breaks in a block are the ones
  // that separate its lines.
  const DIRT = '\tone two\rthree \x1b[31mfour\x1b[0m\x03five';
  /** `DIRT` read as the rule says: the tab a space, the other controls gone, their neighbours joined. */
  const CLEAN_DIRT = ' one twothree [31mfour[0mfive';

  it('drops the control characters from every git line and keeps the line breaks between them', async () => {
    const recap = await buildExpiredConversationRecap(input({
      task: { id: 'task-1', title: 'Fix login', description: '', pr_url: `https://example.test/pr/12${DIRT}` },
    }), {
      readGitState: async () => ({
        branch: 'fix-login',
        commits: [`abc1234 Fix redirect${DIRT}`, 'def5678 Add test'],
        changes: [` M src/auth.ts${DIRT}`, '?? notes.md'],
      }),
    });

    // The whole block, so the lines and the breaks between them are pinned together.
    const branchState = /<branch_state>\n[\s\S]*?\n<\/branch_state>/.exec(recap)?.[0];
    expect(branchState).toBe([
      '<branch_state>',
      'Branch: fix-login, based on main',
      `Pull request: https://example.test/pr/12${CLEAN_DIRT}`,
      'Commits on this branch:',
      `abc1234 Fix redirect${CLEAN_DIRT}`,
      'def5678 Add test',
      'Uncommitted changes:',
      ` M src/auth.ts${CLEAN_DIRT}`,
      '?? notes.md',
      '</branch_state>',
    ].join('\n'));
    expect(controlCodesIn(recap)).toEqual([0x0a]);
    expect(recap.endsWith(CLOSING)).toBe(true);
  });

  it('drops the control characters from the task title and keeps its words', async () => {
    const recap = await buildExpiredConversationRecap(input({
      task: { id: 'task-1', title: 'Fix\tlogin \rredirect \x1b[31mnow\x1b[0m\x03!', description: '', pr_url: null },
    }));

    expect(recap.includes('<title>Fix login redirect [31mnow[0m!</title>')).toBe(true);
    expect(controlCodesIn(recap)).toEqual([0x0a]);
    expect(recap.endsWith(CLOSING)).toBe(true);
  });

  it('drops the control characters from the task description, keeps its words, and keeps its line break', async () => {
    const recap = await buildExpiredConversationRecap(input({
      task: {
        id: 'task-1',
        title: 'Fix login',
        description: 'Users\tland on /home.\rThen\x03 redirect \x1b[31mloops\x1b[0m.\nSecond\tline.',
        pr_url: null,
      },
    }));

    expect(recap.includes(
      '<description>\nUsers land on /home.Then redirect [31mloops[0m.\nSecond line.\n  </description>',
    )).toBe(true);
    expect(controlCodesIn(recap)).toEqual([0x0a]);
    expect(recap.endsWith(CLOSING)).toBe(true);
  });
});

describe('an apostrophe in the recap', () => {
  // A unix-like host quotes the prompt in single quotes, and nushell has no
  // escape for an apostrophe inside them, so the fixed text carries none.
  it.each(['whole-prompt', 'context'] as const)('is absent from a %s recap built from apostrophe-free text', async (mode) => {
    const recap = await buildExpiredConversationRecap(input({
      mode,
      task: { id: 'task-1', title: 'Fix login', description: 'Users land on /home after login.', pr_url: 'https://example.test/pr/12' },
    }), {
      readTaskSummary: async () => 'Moved the redirect into AuthGate.',
      readConversationTail: async () => 'User: does it work?\n\nAgent: Yes, tests pass.',
      readGitState: async () => ({ branch: 'fix-login', commits: ['abc1234 Move redirect'], changes: [' M src/auth.ts'] }),
    });

    // Every optional block went in, so the claim covers the whole recap.
    expect(recap.includes('<task_summary>')).toBe(true);
    expect(recap.includes('<previous_conversation_tail>')).toBe(true);
    expect(recap.includes('<branch_state>')).toBe(true);
    expect(recap.includes("'")).toBe(false);
  });

  it('becomes &apos; when it comes from the content, so the recap still carries none', async () => {
    const recap = await buildExpiredConversationRecap(input(), {
      readTaskSummary: async () => "It doesn't redirect yet.",
    });

    expect(recap.includes('It doesn&apos;t redirect yet.')).toBe(true);
    expect(recap.includes("'")).toBe(false);
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

  describe('when the newest turn alone is longer than the room', () => {
    // The turn reads `User: aaa...az`, 506 characters, ending in `z` so the
    // end that is kept can be told from the start.
    const longTurn: TranscriptEntry[] = [{ kind: 'user', uuid: 'u', ts: 1, text: `${'a'.repeat(499)}z` }];

    it.each([1, 2, 3, 4, 50])('is never longer than a room of %i characters', (maxChars) => {
      const tail = formatConversationTail(longTurn, maxChars);
      expect(tail?.length ?? 0).toBeLessThanOrEqual(maxChars);
    });

    it.each([1, 2, 3])('answers null at a room of %i, which cannot hold the marker and a character of the turn', (maxChars) => {
      expect(formatConversationTail(longTurn, maxChars)).toBeNull();
    });

    it('keeps the marker and the turn\'s last character at a room of 4', () => {
      expect(formatConversationTail(longTurn, 4)).toBe('...z');
    });

    it('keeps the marker and the turn\'s end, filling a room of 50', () => {
      expect(formatConversationTail(longTurn, 50)).toBe(`...${'a'.repeat(46)}z`);
    });

    it('is never longer than the room over every room from 1 to 80, one turn or several', () => {
      for (let maxChars = 1; maxChars <= 80; maxChars += 1) {
        expect(formatConversationTail(longTurn, maxChars)?.length ?? 0).toBeLessThanOrEqual(maxChars);
        expect(formatConversationTail(entries, maxChars)?.length ?? 0).toBeLessThanOrEqual(maxChars);
      }
    });
  });
});
