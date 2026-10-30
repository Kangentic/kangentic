import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cursorProjectSlug, cursorTranscriptFilePath } from '../../src/main/agent/adapters/cursor/session-paths';
import {
  cursorDisplayedUserText,
  parseCursorTranscript,
  readCursorTranscriptPage,
} from '../../src/main/agent/adapters/cursor/transcript-parser';
import { expectPagesTile } from './helpers/history-page-tiling';

describe('cursorProjectSlug', () => {
  it('matches the CLI rule on a Windows working directory', () => {
    expect(cursorProjectSlug('E:\\Desktop\\kangentic')).toBe('E-Desktop-kangentic');
    expect(cursorTranscriptFilePath('E:\\Desktop\\kangentic', 'session-1')).toBe(
      path.join(os.homedir(), '.cursor', 'projects', 'E-Desktop-kangentic', 'agent-transcripts', 'session-1', 'session-1.jsonl'),
    );
  });

  it('drops the leading slash on a POSIX working directory', () => {
    expect(cursorProjectSlug('/home/dev/project')).toBe('home-dev-project');
  });

  it('slugs the path a WSL distro is given', () => {
    expect(cursorProjectSlug('/mnt/e/Desktop/kangentic')).toBe('mnt-e-Desktop-kangentic');
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

  it('shows the unwrapped user text, no clock, and a tool call without a recorded id', async () => {
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
    expect(parsed.entries.every((entry) => entry.ts === 0)).toBe(true);
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
