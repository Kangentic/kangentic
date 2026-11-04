/**
 * Aider's chat history markdown as a structured transcript, and its lifetime
 * token count.
 *
 * The split follows Aider's own reader, `split_chat_history_markdown`
 * (aider/utils.py, v0.86.1): `####` lines are the user, `> ` lines are tool
 * output, every other line is the reply. The fixture is shaped to what
 * aider/io.py, aider/main.py and aider/coders/base_coder.py write: each run
 * opens with its header, the logged command line (a multi-line `--message`
 * spills unprefixed lines) and the announcements, all before the first `####`.
 * Not a capture: Aider is not installed where this was written, and Aider
 * publishes no restored run or multi-line `--message` to replay instead.
 *
 * PUBLISHED is excerpts of the history Aider publishes in its own repository,
 * also not a capture: aider-published-chat-history.source.md names the tag, the
 * lines and the fetch date.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aiderTranscriptUsage,
  parseAiderHistoryMarkdown,
  parseAiderTranscript,
} from '../../src/main/agent/adapters/aider/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';

const SESSION_ID = '3f1c2b7e-1d2a-4c55-9a7e-0b5e1c9d8f00';
const FIXTURE = fs.readFileSync(path.resolve(__dirname, '../fixtures/aider-chat-history-session.md'), 'utf-8');
const PUBLISHED = fs.readFileSync(path.resolve(__dirname, '../fixtures/aider-published-chat-history.md'), 'utf-8');

const temporaryDirectories: string[] = [];
afterEach(() => {
  setParseWindowBytesForTests();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** Each entry as its kind and its text, for a whole-conversation comparison. */
function shapeOf(entries: ReturnType<typeof parseAiderHistoryMarkdown>): Array<[string, string]> {
  return entries.map((entry): [string, string] => {
    if (entry.kind === 'assistant') return ['assistant', entry.blocks.map((block) => ('text' in block ? block.text : '')).join('')];
    if (entry.kind === 'system') return [`system:${entry.subtype}`, entry.text];
    if (entry.kind === 'user') return ['user', entry.text];
    return [entry.kind, ''];
  });
}

/** A working directory holding `content` as the session's history file. */
function writeSessionHistory(content: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-aider-transcript-'));
  temporaryDirectories.push(cwd);
  fs.writeFileSync(path.join(cwd, `.aider.chat.history.${SESSION_ID}.md`), content);
  return cwd;
}

describe('parseAiderHistoryMarkdown', () => {
  it('turns a restored two-run file into turns, commands and a run boundary', () => {
    expect(shapeOf(parseAiderHistoryMarkdown(FIXTURE, SESSION_ID))).toEqual([
      ['user', '<task>\n<title>Add a health check</title>\n</task>'],
      ['assistant', "I'll add a `/health` route to `server.py`.\n\nserver.py\n```python\n@app.get(\"/health\")\ndef health():\n    return {\"status\": \"ok\"}\n```"],
      ['system:session_boundary', 'Aider chat started at 2026-11-03 10:40:11'],
      ['system:command', '/run pytest -q'],
      ['system:command_output', 'Add 0.1k tokens of command output to the chat? (Y)es/(N)o [Yes]: y'],
      ['user', 'also return the version'],
      ['assistant', 'Added a `version` field to the response.'],
    ]);
  });

  it('skips the logged command line, whose multi-line message spills bare lines, and the announcements', () => {
    const entries = parseAiderHistoryMarkdown(FIXTURE, SESSION_ID);
    const text = JSON.stringify(entries);
    expect(text).not.toContain('--chat-history-file');
    expect(text).not.toContain('Main model:');
    expect(text).not.toContain('Repo-map');
  });

  it('drops tool output after a reply, including the bare Cost half of a split report', () => {
    const entries = parseAiderHistoryMarkdown(FIXTURE, SESSION_ID);
    const text = JSON.stringify(entries);
    expect(text).not.toContain('Tokens:');
    expect(text).not.toContain('Cost:');
    expect(text).not.toContain('Applied edit');
  });

  it('keeps a message sent in a mode as a user turn', () => {
    const entries = parseAiderHistoryMarkdown('#### /ask why does it fail?\n\nBecause the port is taken.\n', SESSION_ID);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant']);
  });

  it('keeps a bare Cost line inside the reply when it does not follow a Tokens report', () => {
    const entries = parseAiderHistoryMarkdown(
      '#### what does it cost?\nIt depends.\nCost: $5.00 message, $9.00 session.\n',
      SESSION_ID,
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'It depends.\nCost: $5.00 message, $9.00 session.' }],
    });
  });

  it('parses the older single-run history: turns in order, the /run as a command, no usage lines', () => {
    const older = fs.readFileSync(path.resolve(__dirname, '../fixtures/aider-chat-history.md'), 'utf-8');
    const entries = parseAiderHistoryMarkdown(older, SESSION_ID);
    expect(shapeOf(entries)).toEqual([
      ['user', 'Add a hello world function'],
      ['assistant', "Here's the hello world function:\n\n```python\ndef hello():\n    print(\"Hello, world!\")\n```\n\nI've added a `hello()` function to `main.py`."],
      ['user', 'Now add unit tests for the hello function'],
      ['assistant', "Here are the unit tests:\n\n```python\nimport unittest\nfrom main import hello\n\nclass TestHello(unittest.TestCase):\n    def test_hello(self):\n        hello()\n```\n\nI've added tests in `test_main.py`."],
      ['system:command', '/run python -m pytest'],
      ['system:command_output', 'Add test_main.py to the chat? (Y)es/(N)o [Yes]: Yes'],
      ['assistant', 'I ran the tests and they all pass.'],
    ]);
    const text = JSON.stringify(entries);
    expect(text).not.toContain('Tokens:');
    expect(text).not.toContain('Cost:');
  });

  it('gives every entry ts 0 and a uuid that names its line', () => {
    const entries = parseAiderHistoryMarkdown(FIXTURE, SESSION_ID);
    expect(entries.every((entry) => entry.ts === 0)).toBe(true);
    const lines = FIXTURE.split('\n');
    expect(entries[0].uuid).toBe(`${SESSION_ID}:${lines.indexOf('#### <task>  ')}`);
    expect(new Set(entries.map((entry) => entry.uuid)).size).toBe(entries.length);
  });

  it('numbers lines from the window start it is given', () => {
    const entries = parseAiderHistoryMarkdown('#### hi\nhello\n', SESSION_ID, 40);
    expect(entries.map((entry) => entry.uuid)).toEqual([`${SESSION_ID}:40`, `${SESSION_ID}:41`]);
  });

  it('keeps the leading lines of a cut read that starts mid-turn', () => {
    const entries = parseAiderHistoryMarkdown(
      'rest of a long reply\n> Tokens: 1 sent, 2 received.\n#### next\nok',
      SESSION_ID,
      40,
    );
    expect(shapeOf(entries)).toEqual([
      ['assistant', 'rest of a long reply'],
      ['user', 'next'],
      ['assistant', 'ok'],
    ]);
    expect(entries[0].uuid).toBe(`${SESSION_ID}:40`);
  });

  it('keeps the reply of a cut read that holds no user line', () => {
    const entries = parseAiderHistoryMarkdown('tail of a reply\nmore of it', SESSION_ID, 40);
    expect(shapeOf(entries)).toEqual([['assistant', 'tail of a reply\nmore of it']]);
    expect(entries[0].uuid).toBe(`${SESSION_ID}:40`);
  });

  it('skips the leading lines of a read from the file start as the preamble', () => {
    const entries = parseAiderHistoryMarkdown('rest of a long reply\n#### next\nok', SESSION_ID, 0);
    expect(shapeOf(entries)).toEqual([
      ['user', 'next'],
      ['assistant', 'ok'],
    ]);
  });

  it('keeps a Cost line after a complete one-line report in the reply', () => {
    const entries = parseAiderHistoryMarkdown(
      '#### q\nanswer\n> Tokens: 1 sent, 2 received. Cost: $0.01 message, $0.02 session.\nCost: $5.00 message, $9.00 session.\n',
      SESSION_ID,
    );
    expect(shapeOf(entries)).toEqual([
      ['user', 'q'],
      ['assistant', 'answer'],
      ['assistant', 'Cost: $5.00 message, $9.00 session.'],
    ]);
  });

  it('keeps a Cost line of another shape after a split report in the reply', () => {
    const entries = parseAiderHistoryMarkdown(
      '#### q\n> Tokens: 1.8k sent, 500 cache write, 1.1k cache hit, 234 received.\nCost: roughly five dollars\n',
      SESSION_ID,
    );
    expect(shapeOf(entries)).toEqual([
      ['user', 'q'],
      ['assistant', 'Cost: roughly five dollars'],
    ]);
  });

  it('reads CRLF files', () => {
    const entries = parseAiderHistoryMarkdown(FIXTURE.replace(/\n/g, '\r\n'), SESSION_ID);
    expect(entries).toHaveLength(7);
  });

  describe("Aider's published history", () => {
    const published = shapeOf(parseAiderHistoryMarkdown(PUBLISHED, SESSION_ID));
    const turnsOfRun = (startedAt: string): Array<[string, string]> => {
      const start = published.findIndex(([kind, text]) => kind === 'system:session_boundary' && text.endsWith(startedAt));
      const end = published.findIndex(([kind], index) => index > start && kind === 'system:session_boundary');
      return published.slice(start + 1, end === -1 ? published.length : end);
    };

    it('splits every run into its turns', () => {
      expect(published.map(([kind]) => kind)).toEqual([
        'system:command', 'system:command_output', 'assistant',
        'system:session_boundary', 'user', 'assistant',
        'system:session_boundary', 'system:command',
        'system:session_boundary', 'user', 'assistant',
        'system:session_boundary', 'user', 'assistant',
        'system:session_boundary', 'user', 'assistant',
        'system:session_boundary', 'user', 'assistant',
      ]);
    });

    it('keeps one turn for a /ask that Aider logs twice', () => {
      expect(turnsOfRun('2024-08-10 14:16:24')).toEqual([
        ['user', '/ask hi'],
        ['assistant', 'Hello! How can I assist you today with Aider?'],
      ]);
      expect(turnsOfRun('2024-08-21 16:17:15').filter(([kind]) => kind === 'user')).toEqual([['user', '/ask how are you?']]);
    });

    it('keeps the report out of the reply, whichever shape its Cost half takes', () => {
      const replies = published.filter(([kind]) => kind === 'assistant').map(([, text]) => text);
      expect(replies).toHaveLength(6);
      for (const reply of replies) {
        expect(reply).not.toContain('Cost:');
        expect(reply).not.toContain('Tokens:');
        expect(reply).not.toContain('--no-stream');
      }
    });

    it('reads a /run and its output, and takes a multi-line prompt\'s bare second line for a reply', () => {
      // Aider's own reader splits it the same way: `tool_output` quotes only the
      // first line of a multi-line message.
      expect(published.slice(0, 3)).toEqual([
        ['system:command', '/run tput u6'],
        ['system:command_output', '\x1b[%i%d;%dR\nAdd the output to the chat?'],
        ['assistant', '(y/n/instructions) n'],
      ]);
    });

    it('skips the logged command lines and announcements of every run', () => {
      const text = JSON.stringify(published);
      expect(text).not.toContain('/home/dev');
      expect(text).not.toContain('Repo-map');
      expect(text).not.toContain('Weak model');
    });

    it('adds up its tokens through the window reader', async () => {
      expect(await aiderTranscriptUsage(SESSION_ID, writeSessionHistory(PUBLISHED))).toEqual({ inputTokens: 37022, outputTokens: 254 });
    });
  });

  it('keeps a repeated message that is not the echo of a mode command', () => {
    const entries = parseAiderHistoryMarkdown('#### /ask why?\n\nBecause.\n\n#### why?\n\nAgain, because.\n', SESSION_ID);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('parseAiderTranscript', () => {
  it("reads the session's own file", async () => {
    const cwd = writeSessionHistory(FIXTURE);
    const parsed = await parseAiderTranscript(SESSION_ID, cwd);
    expect(parsed.sourcePath).toBe(path.join(cwd, `.aider.chat.history.${SESSION_ID}.md`));
    expect(parsed.entries).toHaveLength(7);
  });

  it('returns no entries and no path for a missing file, without throwing', async () => {
    const cwd = writeSessionHistory(FIXTURE);
    const parsed = await parseAiderTranscript('another-session', cwd);
    expect(parsed).toEqual({ entries: [], sourcePath: null });
  });

  it('announces a cut read and keeps line-numbered uuids', async () => {
    const cwd = writeSessionHistory(FIXTURE);
    // One byte more than the tail, so the window opens on the newline before
    // the user line: a mid-file window drops through its first newline.
    const tailBytes = Buffer.byteLength(FIXTURE.slice(FIXTURE.indexOf('#### also return the version')));
    setParseWindowBytesForTests(tailBytes + 1);
    const parsed = await parseAiderTranscript(SESSION_ID, cwd);

    expect(parsed.entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
    const user = parsed.entries.find((entry) => entry.kind === 'user');
    expect(user?.uuid).toBe(`${SESSION_ID}:${FIXTURE.split('\n').indexOf('#### also return the version  ')}`);
  });

  it('is what the adapter returns, with no timestamps declared', async () => {
    const cwd = writeSessionHistory(FIXTURE);
    const adapter = new AiderAdapter();
    expect(adapter.transcriptHasTimestamps).toBe(false);
    expect((await adapter.parseTranscript(SESSION_ID, cwd)).entries).toHaveLength(7);
  });
});

describe('aiderTranscriptUsage', () => {
  it("adds up every Tokens report in the session's file", async () => {
    const cwd = writeSessionHistory(FIXTURE);
    expect(await aiderTranscriptUsage(SESSION_ID, cwd)).toEqual({ inputTokens: 8500, outputTokens: 350 });
  });

  it('adds up across read windows when the file is larger than one', async () => {
    const cwd = writeSessionHistory(FIXTURE);
    setParseWindowBytesForTests(200);
    expect(await aiderTranscriptUsage(SESSION_ID, cwd)).toEqual({ inputTokens: 8500, outputTokens: 350 });
  });

  it('adds up the older history: 2.1k + 1.8k + 3.2k sent, 456 + 234 + 189 received', async () => {
    const older = fs.readFileSync(path.resolve(__dirname, '../fixtures/aider-chat-history.md'), 'utf-8');
    const cwd = writeSessionHistory(older);
    expect(await aiderTranscriptUsage(SESSION_ID, cwd)).toEqual({ inputTokens: 7100, outputTokens: 879 });
  });

  it('returns null for a missing file or one with no report', async () => {
    const cwd = writeSessionHistory('#### hi\nhello\n');
    expect(await aiderTranscriptUsage(SESSION_ID, cwd)).toBeNull();
    expect(await aiderTranscriptUsage('another-session', cwd)).toBeNull();
  });

  it('is what the adapter returns, and needs an id and a cwd', async () => {
    const cwd = writeSessionHistory(FIXTURE);
    const adapter = new AiderAdapter();
    expect(await adapter.transcriptUsage({ agentSessionId: SESSION_ID, cwd })).toEqual({ inputTokens: 8500, outputTokens: 350 });
    expect(await adapter.transcriptUsage({ agentSessionId: null, cwd })).toBeNull();
    expect(await adapter.transcriptUsage({ agentSessionId: SESSION_ID, cwd: null })).toBeNull();
    expect(await adapter.transcriptUsage({ agentSessionId: SESSION_ID, cwd: undefined })).toBeNull();
  });
});
