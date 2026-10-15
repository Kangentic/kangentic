/**
 * The size and timing rules of the expired-conversation recap
 * (`src/main/agent/shared/expired-conversation-recap.ts`), which rides the
 * command line as the opening prompt of a session that replaced a resume.
 *
 * `expired-conversation-recap.test.ts` holds the content; these hold the five
 * rules a review pass tightened:
 *  - lengths are measured as cmd.exe receives them (each `%` is four characters),
 *  - `reservedChars` shrinks the room for the optional parts,
 *  - in context mode a reserve that leaves no room for the header and the
 *    pointer gives an empty recap, and whole-prompt mode still gives one,
 *  - the title is capped so the closing instruction always ends the recap,
 *  - the tail read starts with the summary and git reads, and is included only
 *    when at least 400 characters are left for it.
 */
import { describe, it, expect } from 'vitest';
import {
  buildExpiredConversationRecap,
  type ExpiredConversationRecapInput,
  type ExpiredConversationRecapSources,
} from '../../src/main/agent/shared/expired-conversation-recap';
import { INLINE_PROMPT_BUDGET, commandLineLength } from '../../src/main/agent/shared/prompt-budget';
import { CommandBuilder } from '../../src/main/agent/adapters/claude';
import { adaptCommandForShell, buildSpawnClearPrelude } from '../../src/shared/paths';

const CLOSING = 'Reply with a short summary of where the work stands, then wait for the next instruction from the user.';
/** cmd.exe's longest command line. */
const CMD_LINE_LIMIT = 8_191;

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

/** The room the tail source is asked for under `overrides`, from a source that fills what it is asked. */
async function tailRoomAsked(overrides: Partial<ExpiredConversationRecapInput> = {}): Promise<number | null> {
  let askedFor: number | null = null;
  await buildExpiredConversationRecap(input(overrides), {
    readConversationTail: async (_agentSessionId, maxChars) => {
      askedFor = maxChars;
      return 'x'.repeat(maxChars);
    },
  });
  return askedFor;
}

/** The line a cmd host types for `prompt`, through the real Claude builder. */
function typedCmdLine(prompt: string): string {
  const command = new CommandBuilder().buildClaudeCommand({
    cliPath: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd',
    taskId: 'task-1',
    cwd: '/project',
    permissionMode: 'default',
    sessionId: 'aaaaaaaa-1111-4222-8333-555555555555',
    shell: 'cmd.exe',
    prompt,
  });
  return buildSpawnClearPrelude('cmd.exe') + adaptCommandForShell(command, 'cmd.exe');
}

describe('a recap measured as cmd.exe receives it', () => {
  it('stays within 8,191 when its tail is backslashes right before percent signs, which cmd quoting doubles', async () => {
    // `quoteArg` writes `\%` as `\\"^%"`: the backslash run before a percent
    // sign doubles (`escapePercentForCmd`). Counting the `%` alone overran.
    const recap = await buildExpiredConversationRecap(input(), {
      readConversationTail: async (_agentSessionId, maxChars) => '\\%'.repeat(Math.ceil(maxChars / 2)),
    });
    expect(recap.includes('<previous_conversation_tail>')).toBe(true);
    expect(recap.endsWith(CLOSING)).toBe(true);
    expect(typedCmdLine(recap).length).toBeLessThanOrEqual(CMD_LINE_LIMIT);
  });

  it('stays within the inline budget, and the built cmd command within 8,191, when its text is full of percent signs', async () => {
    const recap = await buildExpiredConversationRecap(input({
      task: { id: 'task-1', title: 'Raise 100% coverage', description: 'Cover %PATH% handling in 100% of the cases.', pr_url: null },
    }), {
      readTaskSummary: async () => 'Covered %TEMP% and %APPDATA% in 50% of the files. '.repeat(4),
      readConversationTail: async (_agentSessionId, maxChars) => '%'.repeat(maxChars),
      readGitState: async () => ({ branch: 'coverage-100%', commits: ['abc1234 Reach 100%'], changes: [' M docs/50%.md'] }),
    });

    // Counted here from the rule itself (cmd writes each % as four characters),
    // not through the function under test.
    const percentCount = recap.match(/%/g)?.length ?? 0;
    expect(recap.length + percentCount * 3).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    expect(commandLineLength(recap)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    // The control: the tail went in, cut by its weight, so the recap is far
    // shorter than the budget in plain characters.
    expect(recap.includes('<previous_conversation_tail>')).toBe(true);
    expect(percentCount).toBeGreaterThan(1_000);
    expect(recap.length).toBeLessThan(INLINE_PROMPT_BUDGET - 2_000);
    expect(recap.endsWith(CLOSING)).toBe(true);

    // Through the real Claude builder for a cmd host, the way the spawn types it.
    const command = new CommandBuilder().buildClaudeCommand({
      cliPath: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd',
      taskId: 'task-1',
      cwd: '/project',
      permissionMode: 'default',
      sessionId: 'aaaaaaaa-1111-4222-8333-555555555555',
      shell: 'cmd.exe',
      prompt: recap,
    });
    const typedLine = buildSpawnClearPrelude('cmd.exe') + adaptCommandForShell(command, 'cmd.exe');
    expect(command).not.toContain('%TEMP%');
    expect(typedLine.length).toBeLessThanOrEqual(CMD_LINE_LIMIT);
    // And the line is far past the budget in plain characters, which is what a
    // recap measured by `.length` would have written.
    expect(typedLine.length).toBeGreaterThan(recap.length + 1_000);
  });
});

describe('reservedChars', () => {
  it('shrinks the room the optional parts get by exactly that many characters', async () => {
    const askedWithout = await tailRoomAsked();
    const askedWith = await tailRoomAsked({ reservedChars: 3_000 });

    expect(askedWithout).not.toBeNull();
    expect(askedWith).not.toBeNull();
    expect(askedWith!).toBeLessThan(askedWithout!);
    expect(askedWithout! - askedWith!).toBe(3_000);
  });

  it('keeps a recap whose tail source fills what it is asked for within the budget less the reserve', async () => {
    const recap = await buildExpiredConversationRecap(input({ reservedChars: 3_000 }), {
      readConversationTail: async (_agentSessionId, maxChars) => 'x'.repeat(maxChars),
    });

    expect(recap.includes('<previous_conversation_tail>')).toBe(true);
    expect(commandLineLength(recap)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET - 3_000);
    expect(recap.endsWith(CLOSING)).toBe(true);
  });
});

describe('a reserve that leaves no room for the fixed parts', () => {
  // 7,000 less 6,900 leaves 100 characters, and the header and the pointer
  // alone take over 300.
  const HUGE_RESERVE = 6_900;
  const sources: ExpiredConversationRecapSources = {
    readTaskSummary: async () => 'Moved the redirect into AuthGate.',
    readConversationTail: async (_agentSessionId, maxChars) => 'x'.repeat(maxChars),
    readGitState: async () => ({ branch: 'fix-login', commits: ['abc1234 Move redirect'], changes: [' M src/auth.ts'] }),
  };

  it('in context mode answers an empty recap, so the column\'s pass runs on its own prompt', async () => {
    // The premise: the fixed parts do not fit what the reserve leaves.
    const fixedParts = await buildExpiredConversationRecap(input({ mode: 'context' }));
    expect(commandLineLength(fixedParts)).toBeGreaterThan(INLINE_PROMPT_BUDGET - HUGE_RESERVE);

    const recap = await buildExpiredConversationRecap(input({ mode: 'context', reservedChars: HUGE_RESERVE }), sources);

    expect(recap).toBe('');
  });

  it('in context mode builds the recap, with its pointer, when the reserve leaves room for the fixed parts', async () => {
    const recap = await buildExpiredConversationRecap(input({ mode: 'context', reservedChars: 3_000 }), sources);

    expect(recap).not.toBe('');
    expect(recap).toContain('kangentic_get_transcript tool, passing sessionId aaaaaaaa-1111-4222-8333-444444444444.');
    expect(commandLineLength(recap)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET - 3_000);
  });

  it('in context mode builds the recap when the fixed parts fill the room exactly, and answers empty one character short', async () => {
    // With no source, the recap is the fixed parts and nothing else.
    const fixedPartsLength = commandLineLength(await buildExpiredConversationRecap(input({ mode: 'context' })));

    const exactFit = await buildExpiredConversationRecap(input({ mode: 'context', reservedChars: INLINE_PROMPT_BUDGET - fixedPartsLength }));
    const oneShort = await buildExpiredConversationRecap(input({ mode: 'context', reservedChars: INLINE_PROMPT_BUDGET - fixedPartsLength + 1 }));

    expect(commandLineLength(exactFit)).toBe(fixedPartsLength);
    expect(oneShort).toBe('');
  });

  it('in whole-prompt mode still builds a recap, which is the new session\'s only prompt and ends on the closing instruction', async () => {
    const recap = await buildExpiredConversationRecap(input({ mode: 'whole-prompt', reservedChars: HUGE_RESERVE }), sources);

    expect(recap).not.toBe('');
    expect(recap).toContain('kangentic_get_transcript tool, passing sessionId aaaaaaaa-1111-4222-8333-444444444444.');
    expect(recap.endsWith(CLOSING)).toBe(true);
    expect(commandLineLength(recap)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
  });
});

describe('the title', () => {
  const titleOf = (recap: string): string => /<title>(.*)<\/title>/.exec(recap)?.[1] ?? '';

  it('is capped at 300 characters, so a 7,000-character title still ends the recap with the closing instruction', async () => {
    const recap = await buildExpiredConversationRecap(input({
      task: { id: 'task-1', title: 'T'.repeat(7_000), description: 'Short description.', pr_url: null },
    }));

    expect(recap.endsWith(CLOSING)).toBe(true);
    expect(commandLineLength(recap)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    expect(titleOf(recap).length).toBeGreaterThan(0);
    expect(titleOf(recap).length).toBeLessThanOrEqual(300);
    expect(titleOf(recap).startsWith('TTTT')).toBe(true);
  });

  it('still ends the recap with the closing instruction when escaping would multiply a long title', async () => {
    const recap = await buildExpiredConversationRecap(input({
      task: { id: 'task-1', title: '&'.repeat(7_000), description: '<'.repeat(5_000), pr_url: null },
    }), {
      readConversationTail: async (_agentSessionId, maxChars) => '<'.repeat(maxChars),
    });

    expect(commandLineLength(recap)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    expect(recap.endsWith(CLOSING)).toBe(true);
  });

  it('keeps a title of exactly 300 characters whole', async () => {
    const recap = await buildExpiredConversationRecap(input({
      task: { id: 'task-1', title: 'T'.repeat(300), description: '', pr_url: null },
    }));

    expect(titleOf(recap)).toBe('T'.repeat(300));
  });
});

describe('the tail read', () => {
  it('starts with the summary and git reads, before the summary has answered', async () => {
    const events: string[] = [];
    const sources: ExpiredConversationRecapSources = {
      readTaskSummary: () => new Promise((resolve) => {
        events.push('summary-called');
        setImmediate(() => {
          events.push('summary-answered');
          resolve('The redirect now lives in AuthGate.');
        });
      }),
      readGitState: async () => {
        events.push('git-called');
        return null;
      },
      readConversationTail: async () => {
        events.push('tail-called');
        return 'User: does it work?';
      },
    };

    const recap = await buildExpiredConversationRecap(input(), sources);

    // All three reads begin before the slow one answers, so one slow source
    // costs its own wait and not the sum of them.
    expect(events.indexOf('tail-called')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('tail-called')).toBeLessThan(events.indexOf('summary-answered'));
    expect(events.indexOf('git-called')).toBeLessThan(events.indexOf('summary-answered'));
    expect(recap).toContain('<task_summary>');
    expect(recap).toContain('<previous_conversation_tail>');
  });

  it('is cut to the room the summary leaves, and left out when less than 400 characters remain', async () => {
    const askedFor = await tailRoomAsked();
    expect(askedFor).not.toBeNull();
    const buildWithSummary = (summaryLength: number) => buildExpiredConversationRecap(input(), {
      readTaskSummary: async () => 's'.repeat(summaryLength),
      readConversationTail: async (_agentSessionId, maxChars) => 't'.repeat(maxChars),
    });

    // A summary that leaves about 270 characters: the summary fits, the tail does not.
    // Compared as booleans: a failure would otherwise print a 7,000-character recap.
    const tooLittleRoom = await buildWithSummary(askedFor! - 300);
    expect(tooLittleRoom.includes('<task_summary>')).toBe(true);
    expect(tooLittleRoom.includes('<previous_conversation_tail>')).toBe(false);
    expect(commandLineLength(tooLittleRoom)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    expect(tooLittleRoom.endsWith(CLOSING)).toBe(true);

    // A summary that leaves about 770: the tail goes in, cut to what is left.
    const enoughRoom = await buildWithSummary(askedFor! - 800);
    expect(enoughRoom).toContain('<task_summary>');
    const tailInside = /<previous_conversation_tail>\n([\s\S]*?)\n<\/previous_conversation_tail>/.exec(enoughRoom)?.[1] ?? '';
    expect(tailInside.length).toBeGreaterThanOrEqual(400);
    expect(tailInside.length).toBeLessThan(askedFor!);
    expect(commandLineLength(enoughRoom)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    expect(enoughRoom.endsWith(CLOSING)).toBe(true);
  });

  it('is never asked for with less than 400 characters of room, and is asked for at exactly 400', async () => {
    const askedFor = await tailRoomAsked();
    expect(askedFor).not.toBeNull();

    // The reserve leaves 399: not worth a call to the worker.
    expect(await tailRoomAsked({ reservedChars: askedFor! - 399 })).toBeNull();
    // The reserve leaves exactly 400: asked for, with that room.
    expect(await tailRoomAsked({ reservedChars: askedFor! - 400 })).toBe(400);
  });
});
