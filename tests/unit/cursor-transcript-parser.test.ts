import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cursorProjectSlug, cursorTranscriptFilePath } from '../../src/main/agent/adapters/cursor/session-paths';
import {
  cursorDisplayedUserText,
  parseCursorClock,
  parseCursorTranscript,
  readCursorTranscriptPage,
} from '../../src/main/agent/adapters/cursor/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import { expectPagesTile } from './helpers/history-page-tiling';

describe('cursorProjectSlug', () => {
  it('matches the CLI rule on a Windows working directory', () => {
    expect(cursorProjectSlug('C:\\Users\\dev\\project')).toBe('C-Users-dev-project');
    expect(cursorTranscriptFilePath('C:\\Users\\dev\\project', 'session-1')).toBe(
      path.join(os.homedir(), '.cursor', 'projects', 'C-Users-dev-project', 'agent-transcripts', 'session-1', 'session-1.jsonl'),
    );
  });

  it('drops the leading slash on a POSIX working directory', () => {
    expect(cursorProjectSlug('/home/dev/project')).toBe('home-dev-project');
  });

  it('slugs the path a WSL distro is given', () => {
    expect(cursorProjectSlug('/mnt/c/Users/dev/project')).toBe('mnt-c-Users-dev-project');
  });
});

describe('cursorDisplayedUserText', () => {
  it('drops the clock tag and the user_query wrapper', () => {
    const stored = '<timestamp>Friday, Oct 30, 2026, 4:44 PM (UTC+8)</timestamp>\n<user_query>\nshow the files\n</user_query>';
    expect(cursorDisplayedUserText(stored)).toBe('show the files');
  });

  it('unwraps a board prompt stored as one task element', () => {
    const stored = '<user_query>\n<task>\nfix the button\n</task>\n</user_query>';
    expect(cursorDisplayedUserText(stored)).toBe('fix the button');
  });

  it('keeps a plain sentence the file stored without tags', () => {
    expect(cursorDisplayedUserText('hello')).toBe('hello');
  });

  it('skips injected context that is not a user turn', () => {
    expect(cursorDisplayedUserText('<available_subagent_types>\n- generalPurpose\n</available_subagent_types>')).toBeNull();
  });

  it('reads the query after a slash-command skill Cursor inlined in front of it', () => {
    const stored = [
      '<manually_attached_skills>',
      'The user has manually attached the following skills to their message.',
      'Skill Name: pull-request',
      '</manually_attached_skills>',
      '<timestamp>Thursday, Nov 5, 2026, 3:53 PM (UTC+8)</timestamp>',
      '<user_query>',
      '/pull-request',
      '</user_query>',
    ].join('\n');
    expect(cursorDisplayedUserText(stored)).toBe('/pull-request');
  });

  it('reads the query after Cursor wraps a slash command in cursor_commands', () => {
    const stored = [
      '<manually_attached_skills>',
      'The user has manually attached the following skills to their message.',
      'Skill Name: merge-pull-request',
      '</manually_attached_skills>',
      '<cursor_commands>',
      '--- Cursor Command: merge-pull-request ---',
      'Read and follow the skill.',
      '</cursor_commands>',
      '<timestamp>Monday, Nov 9, 2026, 5:10 PM (UTC+8)</timestamp>',
      '<user_query>',
      '/merge-pull-request',
      '</user_query>',
    ].join('\n');
    expect(cursorDisplayedUserText(stored)).toBe('/merge-pull-request');
  });

  it('reads the query when only the command wrapper sits in front of the clock', () => {
    const stored = [
      '<cursor_commands>',
      '--- Cursor Command: pull-request ---',
      '</cursor_commands>',
      '<timestamp>Monday, Nov 9, 2026, 5:10 PM (UTC+8)</timestamp>',
      '<user_query>',
      '/pull-request',
      '</user_query>',
    ].join('\n');
    expect(cursorDisplayedUserText(stored)).toBe('/pull-request');
  });
});

describe('parseCursorClock', () => {
  it('reads an English minute clock with a UTC offset', () => {
    expect(parseCursorClock('Thursday, Jan 1, 2026, 9:00 AM (UTC+0)')).toBe(Date.UTC(2026, 0, 1, 9, 0));
    expect(parseCursorClock('Friday, Oct 30, 2026, 4:44 PM (UTC+8)')).toBe(Date.UTC(2026, 9, 30, 8, 44));
    expect(parseCursorClock('Monday, Aug 24, 2026, 12:00 AM (UTC+8)')).toBe(Date.UTC(2026, 7, 23, 16, 0));
    expect(parseCursorClock('Monday, Aug 24, 2026, 12:00 PM (UTC-5)')).toBe(Date.UTC(2026, 7, 24, 17, 0));
  });

  it('returns 0 when the string is not that clock', () => {
    expect(parseCursorClock('')).toBe(0);
    expect(parseCursorClock('2026-01-01T09:00:00.000Z')).toBe(0);
    expect(parseCursorClock('Thursday, January 1, 2026, 9:00 AM (UTC+0)')).toBe(0);
  });

  it('reads an offset that carries minutes', () => {
    expect(parseCursorClock('Monday, Aug 24, 2026, 3:16 PM (UTC+5:30)')).toBe(Date.UTC(2026, 7, 24, 9, 46));
    expect(parseCursorClock('Monday, Aug 24, 2026, 3:16 PM (UTC-3:30)')).toBe(Date.UTC(2026, 7, 24, 18, 46));
    expect(parseCursorClock('Monday, Aug 24, 2026, 3:16 PM (UTC+14)')).toBe(Date.UTC(2026, 7, 24, 1, 16));
  });

  it('returns 0 for a field out of range instead of rolling it into the next unit', () => {
    expect(parseCursorClock('Monday, Aug 24, 2026, 13:00 PM (UTC+0)')).toBe(0);
    expect(parseCursorClock('Monday, Aug 24, 2026, 0:30 AM (UTC+0)')).toBe(0);
    expect(parseCursorClock('Monday, Aug 24, 2026, 3:75 PM (UTC+0)')).toBe(0);
    expect(parseCursorClock('Monday, Feb 30, 2026, 3:16 PM (UTC+0)')).toBe(0);
    expect(parseCursorClock('Monday, Feb 29, 2027, 3:16 PM (UTC+0)')).toBe(0);
    expect(parseCursorClock('Monday, Aug 24, 2026, 3:16 PM (UTC+15)')).toBe(0);
    expect(parseCursorClock('Monday, Aug 24, 2026, 3:16 PM (UTC+5:60)')).toBe(0);
  });

  it('accepts Feb 29 in a leap year', () => {
    expect(parseCursorClock('Tuesday, Feb 29, 2028, 12:00 PM (UTC+0)')).toBe(Date.UTC(2028, 1, 29, 12, 0));
  });
});

describe('cursorDisplayedUserText wrapper order', () => {
  const skills = [
    '<manually_attached_skills>',
    'The user has manually attached the following skills to their message.',
    'Skill Name: pull-request',
    '</manually_attached_skills>',
  ];
  const commands = [
    '<cursor_commands>',
    '--- Cursor Command: pull-request ---',
    '</cursor_commands>',
  ];
  const clockAndQuery = [
    '<timestamp>Monday, Nov 9, 2026, 5:10 PM (UTC+8)</timestamp>',
    '<user_query>',
    '/pull-request',
    '</user_query>',
  ];

  it('reads the query when cursor_commands comes before manually_attached_skills', () => {
    expect(cursorDisplayedUserText([...commands, ...skills, ...clockAndQuery].join('\n'))).toBe('/pull-request');
  });

  it('is not a turn when another leading tag follows the wrappers', () => {
    const stored = [
      ...skills,
      '<available_subagent_types>',
      '- generalPurpose',
      '</available_subagent_types>',
      ...clockAndQuery,
    ].join('\n');
    expect(cursorDisplayedUserText(stored)).toBeNull();
  });
});

const SESSION_ID = 'aaaa-bbbb-cccc-dddd';

function writeFixture(lines: object[]): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-transcript-test-'));
  const filePath = path.join(directory, 'session.jsonl');
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n'));
  return filePath;
}

function userLine(text: string): object {
  return { role: 'user', message: { content: [{ type: 'text', text }] } };
}

describe('parseCursorTranscript', () => {
  let temporaryFile: string | null = null;

  afterEach(() => {
    if (!temporaryFile) return;
    try { fs.rmSync(path.dirname(temporaryFile), { recursive: true, force: true }); } catch { /* ignore */ }
    temporaryFile = null;
  });

  it('returns no entries when the file is missing', async () => {
    const parsed = await parseCursorTranscript(SESSION_ID, path.join(os.tmpdir(), 'cursor-transcript-missing.jsonl'));
    expect(parsed).toEqual({ entries: [], sourcePath: null });
  });

  it('shows the unwrapped user text, stamps the clock onto the turn, and a tool call without a recorded id', async () => {
    temporaryFile = writeFixture([
      userLine('<timestamp>Friday, Oct 30, 2026, 4:44 PM (UTC+8)</timestamp>\n<user_query>\nlist the files\n</user_query>'),
      { type: 'turn_ended', status: 'success' },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Looking now.' },
            { type: 'tool_use', name: 'Glob', input: { pattern: '*' } },
          ],
        },
      },
      userLine('<available_subagent_types>\n- generalPurpose\n</available_subagent_types>'),
    ]);

    const parsed = await parseCursorTranscript(SESSION_ID, temporaryFile);
    expect(parsed.sourcePath).toBe(temporaryFile);
    expect(parsed.entries.map((entry) => entry.kind)).toEqual(['user', 'assistant']);
    const clock = Date.UTC(2026, 9, 30, 8, 44);
    expect(parsed.entries.map((entry) => entry.ts)).toEqual([clock, clock]);
    const user = parsed.entries[0];
    const assistant = parsed.entries[1];
    if (user?.kind !== 'user' || assistant?.kind !== 'assistant') throw new Error('expected a user turn then an assistant turn');
    expect(user.text).toBe('list the files');
    expect(user.text).not.toContain('<user_query>');
    expect(user.text).not.toContain('<timestamp>');
    expect(assistant.blocks).toEqual([
      { type: 'text', text: 'Looking now.' },
      { type: 'tool_use', id: `${SESSION_ID}:2:tool:0`, name: 'Glob', input: { pattern: '*' } },
    ]);
  });

  it('stamps a slash-command clock onto the user turn and the reply that follows', async () => {
    const stored = [
      '<manually_attached_skills>',
      'The user has manually attached the following skills to their message.',
      'Skill Name: merge-pull-request',
      '</manually_attached_skills>',
      '<cursor_commands>',
      '--- Cursor Command: merge-pull-request ---',
      '</cursor_commands>',
      '<timestamp>Monday, Nov 9, 2026, 5:10 PM (UTC+8)</timestamp>',
      '<user_query>',
      '/merge-pull-request',
      '</user_query>',
    ].join('\n');
    temporaryFile = writeFixture([
      userLine(stored),
      { role: 'assistant', message: { content: [{ type: 'text', text: 'PR: merged' }] } },
    ]);

    const parsed = await parseCursorTranscript(SESSION_ID, temporaryFile);
    const clock = Date.UTC(2026, 10, 9, 9, 10);
    expect(parsed.entries.map((entry) => [entry.kind, entry.ts])).toEqual([
      ['user', clock],
      ['assistant', clock],
    ]);
    const user = parsed.entries[0];
    if (user?.kind !== 'user') throw new Error('expected the slash command first');
    expect(user.text).toBe('/merge-pull-request');
  });

  it('replays the shape of a real Cursor transcript', async () => {
    // tests/fixtures/cursor-agent-transcript.jsonl is written in the record
    // shape a local cursor-agent transcript showed (keys, nesting, the clock
    // tag and user_query wrapper, tool_use with no id, the turn_ended marker),
    // with every value its own. The second turn's slash-command record (the
    // manually_attached_skills and cursor_commands wrappers in front of the
    // clock) takes its wrapper shape from the contributor's live Cursor CLI
    // run in PR 871. Replace it with a sanitized capture when one is recorded.
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'cursor-agent-transcript.jsonl');
    const parsed = await parseCursorTranscript(SESSION_ID, fixturePath);
    expect(parsed.sourcePath).toBe(fixturePath);
    const clock = Date.UTC(2026, 0, 1, 9, 0);
    const slashClock = Date.UTC(2026, 0, 1, 9, 5);
    expect(parsed.entries.map((entry) => [entry.kind, entry.uuid, entry.ts, entry.tsPrecision])).toEqual([
      ['user', `${SESSION_ID}:0`, clock, 'minute'],
      ['assistant', `${SESSION_ID}:1`, clock, 'minute'],
      ['assistant', `${SESSION_ID}:2`, clock, 'minute'],
      ['assistant', `${SESSION_ID}:3`, clock, 'minute'],
      ['user', `${SESSION_ID}:5`, slashClock, 'minute'],
      ['assistant', `${SESSION_ID}:6`, slashClock, 'minute'],
    ]);
    const [user, schemaLookup, toolCall, answer, slashCommand, slashReply] = parsed.entries;
    if (slashCommand?.kind !== 'user' || slashReply?.kind !== 'assistant') throw new Error('expected the slash command turn last');
    expect(slashCommand.text).toBe('/pull-request');
    expect(slashReply.blocks).toEqual([{ type: 'text', text: 'Opened a pull request for the branch. All checks passed.' }]);
    if (user?.kind !== 'user') throw new Error('expected the user turn first');
    expect(user.text).toBe('Call the kangentic_search tool once with mode "hybrid" and query "release checklist". Then reply in one sentence.');
    if (schemaLookup?.kind !== 'assistant' || toolCall?.kind !== 'assistant' || answer?.kind !== 'assistant') {
      throw new Error('expected three assistant entries after the user turn');
    }
    expect(schemaLookup.blocks).toEqual([
      { type: 'text', text: "I'll look up the search tool's schema, then run that query once." },
      { type: 'tool_use', id: `${SESSION_ID}:1:tool:0`, name: 'GetDynamicTools', input: { namespace: 'kangentic', toolName: 'kangentic_search' } },
    ]);
    expect(toolCall.blocks.map((block) => (block.type === 'tool_use' ? block.name : block.type))).toEqual(['CallDynamicTool']);
    expect(answer.blocks).toEqual([{ type: 'text', text: 'The search found no task matching release checklist.' }]);

    await expectPagesTile({
      filePath: fixturePath,
      conversationId: SESSION_ID,
      parseTail: async () => (await parseCursorTranscript(SESSION_ID, fixturePath)).entries,
      readPage: (request) => readCursorTranscriptPage(SESSION_ID, fixturePath, request),
      // Smaller than the file, and each larger than its longest line.
      tailBytes: 800,
      pageBytes: 700,
    });
  });

  it('pages the same entries a whole-file read produces', async () => {
    const lines: object[] = [];
    for (let index = 0; index < 8; index += 1) {
      lines.push(userLine(`<user_query>\nturn ${index} ${'x'.repeat(80)}\n</user_query>`));
      lines.push({ role: 'assistant', message: { content: [{ type: 'text', text: `reply ${index} ${'y'.repeat(80)}` }] } });
    }
    temporaryFile = writeFixture(lines);
    const filePath = temporaryFile;

    await expectPagesTile({
      filePath,
      conversationId: SESSION_ID,
      parseTail: async () => (await parseCursorTranscript(SESSION_ID, filePath)).entries,
      readPage: (request) => readCursorTranscriptPage(SESSION_ID, filePath, request),
      tailBytes: 500,
      pageBytes: 250,
    });
  });

  it('carries the latest clock onto lines without one and ignores injected context in between', async () => {
    const firstClock = Date.UTC(2026, 0, 1, 9, 0);
    const secondClock = Date.UTC(2026, 0, 1, 10, 30);
    const injected = userLine('<available_subagent_types>\n- generalPurpose\n</available_subagent_types>');
    const reply = (text: string): object => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
    temporaryFile = writeFixture([
      userLine('<timestamp>Thursday, Jan 1, 2026, 9:00 AM (UTC+0)</timestamp>\n<user_query>\nfirst\n</user_query>'),
      reply('first reply'),
      injected,
      userLine('<timestamp>Thursday, Jan 1, 2026, 10:30 AM (UTC+0)</timestamp>\n<user_query>\nsecond\n</user_query>'),
      reply('second reply'),
      injected,
      userLine('follow up with no clock'),
      reply('third reply'),
    ]);

    const parsed = await parseCursorTranscript(SESSION_ID, temporaryFile);
    expect(parsed.entries.map((entry) => [entry.kind, entry.ts])).toEqual([
      ['user', firstClock],
      ['assistant', firstClock],
      ['user', secondClock],
      ['assistant', secondClock],
      ['user', secondClock],
      ['assistant', secondClock],
    ]);
    for (const entry of parsed.entries) {
      expect(entry.tsPrecision).toBe('minute');
    }
  });

  it('leaves tsPrecision off an entry with no clock', async () => {
    temporaryFile = writeFixture([
      userLine('no clock anywhere'),
      { role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);

    const parsed = await parseCursorTranscript(SESSION_ID, temporaryFile);
    expect(parsed.entries.map((entry) => entry.ts)).toEqual([0, 0]);
    for (const entry of parsed.entries) {
      expect('tsPrecision' in entry).toBe(false);
    }
  });
});

describe('the clock a page opening mid-turn gets from before its window', () => {
  const clockA = Date.UTC(2026, 0, 1, 9, 0);
  const clockB = Date.UTC(2026, 0, 1, 10, 30);
  const lookbackBytes = 256 * 1024;
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  const clockedUser = (clock: string): object =>
    userLine(`<timestamp>${clock}</timestamp>\n<user_query>\nplease continue\n</user_query>`);
  const assistantText = (text: string): object => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
  const A_LINE = (): object => clockedUser('Thursday, Jan 1, 2026, 9:00 AM (UTC+0)');
  const B_LINE = (): object => clockedUser('Thursday, Jan 1, 2026, 10:30 AM (UTC+0)');
  const bulk = (count: number, characters: number): object[] =>
    Array.from({ length: count }, (_unused, index) => assistantText(`${index} ${'x'.repeat(characters)}`));

  /** Write the lines and return the byte each line starts at. */
  function writeLines(lines: object[], lineEnding = '\n'): { filePath: string; offsets: number[] } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-transcript-lookback-'));
    directories.push(directory);
    const filePath = path.join(directory, 'session.jsonl');
    const offsets: number[] = [];
    let offset = 0;
    const serialized = lines.map((line) => {
      offsets.push(offset);
      const text = JSON.stringify(line);
      offset += Buffer.byteLength(text) + lineEnding.length;
      return text;
    });
    fs.writeFileSync(filePath, serialized.join(lineEnding));
    return { filePath, offsets };
  }

  async function pageFrom(filePath: string, byte: number) {
    const result = await readCursorTranscriptPage(SESSION_ID, filePath, { direction: 'after', cursor: `j:${byte}`, maxBytes: 40_000 });
    if (result.status !== 'ok') throw new Error(`expected a page, got ${result.status}`);
    return result.page;
  }

  it('stamps the nearest earlier user clock, not an older one beyond a large gap', async () => {
    // A, 400KB of replies, B, then the page opens on a reply after B.
    const lines = [A_LINE(), ...bulk(20, 20_000), B_LINE(), ...bulk(10, 2_000)];
    const { filePath, offsets } = writeLines(lines);
    expect(fs.statSync(filePath).size).toBeGreaterThan(lookbackBytes);

    const page = await pageFrom(filePath, offsets[22]);
    expect(page.entries[0].kind).toBe('assistant');
    expect(page.entries.length).toBe(10);
    for (const entry of page.entries) {
      expect(entry.ts).toBe(clockB);
      expect(entry.tsPrecision).toBe('minute');
    }
  });

  it('passes over a user line with no clock and an injected line to an older clock', async () => {
    const lines = [
      A_LINE(), ...bulk(2, 200),
      userLine('a follow up that carries no clock'),
      userLine('<available_subagent_types>\n- generalPurpose\n</available_subagent_types>'),
      ...bulk(5, 200),
    ];
    const { filePath, offsets } = writeLines(lines);

    const page = await pageFrom(filePath, offsets[5]);
    expect(page.entries.map((entry) => entry.ts)).toEqual([clockA, clockA, clockA, clockA, clockA]);
  });

  it('leaves the opening replies at ts 0 when no user clock lies within the lookback', async () => {
    const lines = [A_LINE(), ...bulk(15, 20_000), ...bulk(5, 2_000)];
    const { filePath, offsets } = writeLines(lines);

    const page = await pageFrom(filePath, offsets[16]);
    expect(page.entries.length).toBe(5);
    for (const entry of page.entries) {
      expect(entry.ts).toBe(0);
      expect('tsPrecision' in entry).toBe(false);
    }
  });

  it('reads the earlier clock out of a file written with CRLF line endings', async () => {
    const lines = [A_LINE(), ...bulk(3, 200)];
    const { filePath, offsets } = writeLines(lines, '\r\n');

    const page = await pageFrom(filePath, offsets[2]);
    expect(page.entries.map((entry) => entry.ts)).toEqual([clockA, clockA]);
  });

  it('reads the earlier clock for the tail window of a truncated transcript', async () => {
    const lines = [A_LINE(), ...bulk(12, 2_000), B_LINE(), ...bulk(8, 2_000)];
    const { filePath } = writeLines(lines);

    setParseWindowBytesForTests(5_000);
    try {
      const parsed = await parseCursorTranscript(SESSION_ID, filePath);
      const turns = parsed.entries.filter((entry) => entry.kind !== 'system');
      expect(turns.length).toBeGreaterThan(0);
      expect(turns[0].kind).toBe('assistant');
      for (const entry of turns) expect(entry.ts).toBe(clockB);
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('never reads back when the window opens on a user line that has its own clock', async () => {
    const lines = [A_LINE(), ...bulk(3, 200), B_LINE(), ...bulk(3, 200)];
    const { filePath, offsets } = writeLines(lines);
    const openSpy = vi.spyOn(fs, 'openSync');
    try {
      const opensOf = () => openSpy.mock.calls.filter((call) => call[0] === filePath).length;

      const onUser = await pageFrom(filePath, offsets[4]);
      expect(onUser.entries.map((entry) => entry.ts)).toEqual([clockB, clockB, clockB, clockB]);
      expect(opensOf()).toBe(0);

      // Control: a page opening on a reply does read back, so the spy sees the parser's open.
      const onReply = await pageFrom(filePath, offsets[5]);
      expect(onReply.entries.map((entry) => entry.ts)).toEqual([clockB, clockB, clockB]);
      expect(opensOf()).toBe(1);
    } finally {
      openSpy.mockRestore();
    }
  });
});
