import { describe, it, expect, afterEach } from 'vitest';
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
    // with every value its own. Replace it with a sanitized capture when one
    // is recorded.
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'cursor-agent-transcript.jsonl');
    const parsed = await parseCursorTranscript(SESSION_ID, fixturePath);
    expect(parsed.sourcePath).toBe(fixturePath);
    const clock = Date.UTC(2026, 0, 1, 9, 0);
    expect(parsed.entries.map((entry) => [entry.kind, entry.uuid, entry.ts])).toEqual([
      ['user', `${SESSION_ID}:0`, clock],
      ['assistant', `${SESSION_ID}:1`, clock],
      ['assistant', `${SESSION_ID}:2`, clock],
      ['assistant', `${SESSION_ID}:3`, clock],
    ]);
    const [user, schemaLookup, toolCall, answer] = parsed.entries;
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
      tailBytes: 500,
      pageBytes: 400,
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
});
