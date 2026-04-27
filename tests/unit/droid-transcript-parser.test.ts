import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDroidTranscript, droidTranscriptFilePath } from '../../src/main/agent/adapters/droid/transcript-parser';
import { transcriptToMarkdown } from '../../src/shared/transcript-format';

describe('droidTranscriptFilePath', () => {
  it('builds the expected path on Windows-style cwds', () => {
    const filePath = droidTranscriptFilePath('aaaa-bbbb', 'C:\\Users\\dev\\project');
    expect(filePath).toBe(
      path.join(os.homedir(), '.factory', 'sessions', '-C-Users-dev-project', 'aaaa-bbbb.jsonl'),
    );
  });

  it('builds the expected path on POSIX-style cwds', () => {
    const filePath = droidTranscriptFilePath('aaaa-bbbb', '/home/dev/project');
    expect(filePath).toBe(
      path.join(os.homedir(), '.factory', 'sessions', '-home-dev-project', 'aaaa-bbbb.jsonl'),
    );
  });
});

function writeFixture(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-transcript-test-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

describe('parseDroidTranscript', () => {
  let tmpFile: string | null = null;

  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
      tmpFile = null;
    }
  });

  it('returns [] for missing files', async () => {
    const entries = await parseDroidTranscript(path.join(os.tmpdir(), 'does-not-exist.jsonl'));
    expect(entries).toEqual([]);
  });

  it('parses user, assistant, and tool_result entries from the message envelope', async () => {
    tmpFile = writeFixture([
      { type: 'session_start', id: 's1', title: 't', owner: 'dev', version: 2, cwd: 'C:\\Users\\dev\\project' },
      {
        type: 'message',
        id: 'u1',
        timestamp: '2026-04-09T00:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      },
      {
        type: 'message',
        id: 'a1',
        timestamp: '2026-04-09T00:00:01Z',
        parentId: 'u1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_123', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'message',
        id: 'r1',
        timestamp: '2026-04-09T00:00:02Z',
        parentId: 'a1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'file1.txt\nfile2.txt' }],
        },
      },
      {
        type: 'message',
        id: 'a2',
        timestamp: '2026-04-09T00:00:03Z',
        parentId: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Two files found.' }] },
      },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ kind: 'user', uuid: 'u1', text: 'list files' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      uuid: 'a1',
      blocks: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_123', name: 'Bash', input: { command: 'ls' } },
      ],
    });
    expect(entries[2]).toMatchObject({
      kind: 'tool_result',
      uuid: 'r1',
      toolUseId: 'toolu_123',
      content: 'file1.txt\nfile2.txt',
      isError: false,
    });
    expect(entries[3]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: 'Two files found.' }] });
  });

  it('joins multi-text user content blocks with newlines (system-reminders + prompt)', async () => {
    // Real Droid sessions prepend two `<system-reminder>` text blocks to
    // every user prompt (env info + TodoWrite hint). The parser keeps them
    // verbatim and joins with \n, matching Claude's behavior.
    tmpFile = writeFixture([
      {
        type: 'message',
        id: 'u1',
        timestamp: '2026-04-09T00:00:00Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>env info</system-reminder>' },
            { type: 'text', text: '<system-reminder>todo hint</system-reminder>' },
            { type: 'text', text: 'do the thing' },
          ],
        },
      },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'user',
      text: '<system-reminder>env info</system-reminder>\n<system-reminder>todo hint</system-reminder>\ndo the thing',
    });
  });

  it('flattens tool_result content arrays (text + image blocks)', async () => {
    tmpFile = writeFixture([
      {
        type: 'message',
        id: 'r1',
        timestamp: '2026-04-09T00:00:00Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'x',
              is_error: true,
              content: [
                { type: 'text', text: 'boom' },
                { type: 'image' },
              ],
            },
          ],
        },
      },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_result',
      isError: true,
      content: 'boom\n[image]',
    });
  });

  it('preserves non-empty thinking blocks and drops empty signature-only ones', async () => {
    // Forward-compat: Droid 0.109 has not been observed emitting thinking
    // blocks, but reasoning models (Sonnet, Opus, GPT-5) could surface
    // them in a future Droid version. Lock the same filter Claude uses.
    tmpFile = writeFixture([
      {
        type: 'message',
        id: 'a1',
        timestamp: '2026-04-09T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '', signature: 'sig...' }],
        },
      },
      {
        type: 'message',
        id: 'a2',
        timestamp: '2026-04-09T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning...' },
            { type: 'text', text: 'done' },
          ],
        },
      },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'assistant',
      uuid: 'a2',
      blocks: [
        { type: 'thinking', text: 'reasoning...' },
        { type: 'text', text: 'done' },
      ],
    });
  });

  it('skips bookkeeping top-level types and unknown types', async () => {
    // Spec mentioned `session_start`, `system`, `completion`, `todo_state`,
    // `compaction_state` as types the parser should ignore. Only
    // `session_start` has been observed empirically; the others are listed
    // in the task brief and may appear in longer or future Droid sessions.
    // The parser ignores any non-`message` top-level type for forward-compat.
    tmpFile = writeFixture([
      { type: 'session_start', id: 's1', cwd: 'C:\\Users\\dev\\project' },
      { type: 'system', subtype: 'notice' },
      { type: 'completion', sessionId: 's1' },
      { type: 'todo_state', todos: [] },
      { type: 'compaction_state', tokensSaved: 100 },
      { type: 'unknown_future_type', foo: 'bar' },
      {
        type: 'message',
        id: 'u1',
        timestamp: '2026-04-09T00:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'hello' });
  });

  it('skips messages whose content is missing or non-array', async () => {
    tmpFile = writeFixture([
      { type: 'message', id: 'a', timestamp: '2026-04-09T00:00:00Z', message: { role: 'user', content: 'string-shorthand-not-emitted-by-droid' } },
      { type: 'message', id: 'b', timestamp: '2026-04-09T00:00:01Z', message: { role: 'user' } },
      { type: 'message', id: 'c', timestamp: '2026-04-09T00:00:02Z' },
      { type: 'message', id: 'd', timestamp: '2026-04-09T00:00:03Z', message: { role: 'user', content: [{ type: 'text', text: 'real' }] } },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'real' });
  });

  it('skips assistant messages with no renderable blocks', async () => {
    tmpFile = writeFixture([
      {
        type: 'message',
        id: 'a1',
        timestamp: '2026-04-09T00:00:00Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
      },
      {
        type: 'message',
        id: 'a2',
        timestamp: '2026-04-09T00:00:01Z',
        message: { role: 'assistant', content: [] },
      },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toEqual([]);
  });

  it('tolerates malformed JSON lines without throwing', async () => {
    tmpFile = writeFixture([
      { type: 'message', id: 'u1', timestamp: '2026-04-09T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
    ]);
    fs.appendFileSync(tmpFile, '\n{not valid json\n');
    fs.appendFileSync(tmpFile, JSON.stringify({ type: 'message', id: 'u2', timestamp: '2026-04-09T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'two' }] } }) + '\n');

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ text: 'one' });
    expect(entries[1]).toMatchObject({ text: 'two' });
  });

  it('processes tool_result before user text when both appear in the same content array', async () => {
    // The parser iterates the content array in order. For a user-role message
    // that mixes a tool_result block (e.g. from a prior tool call) and a new
    // text prompt in the same envelope, the tool_result entry is pushed to
    // `entries` first; the text block is accumulated into `textParts` and
    // pushed after the loop. This ordering is intentional: Droid's schema
    // allows mixed content in a single user message when a tool result is
    // immediately followed by a follow-up user instruction.
    tmpFile = writeFixture([
      {
        type: 'message',
        id: 'mixed-1',
        timestamp: '2026-04-09T00:00:00Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'result text' },
            { type: 'text', text: 'now do this' },
          ],
        },
      },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    // tool_result is emitted first, then the user text entry follows.
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'tool_result',
      uuid: 'mixed-1',
      toolUseId: 'toolu_abc',
      content: 'result text',
      isError: false,
    });
    expect(entries[1]).toMatchObject({
      kind: 'user',
      uuid: 'mixed-1',
      text: 'now do this',
    });
  });

  it('stringifyToolResultContent: returns empty string for null content', async () => {
    // Defensive branch: `null` is neither a string nor an array, so
    // stringifyToolResultContent() returns ''. This guards against schema
    // drift where a future Droid version emits `content: null` for an
    // empty tool result (e.g. a write-only tool that returned nothing).
    tmpFile = writeFixture([
      {
        type: 'message',
        id: 'r-null',
        timestamp: '2026-04-09T00:00:00Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_null', content: null }],
        },
      },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'toolu_null',
      content: '',
      isError: false,
    });
  });

  it('stringifyToolResultContent: returns empty string for numeric content', async () => {
    // Defensive branch: a number (e.g. 42) is neither a string nor an
    // array, so the else-branch returns ''. Tests the typeof guard that
    // sits before the Array.isArray check in stringifyToolResultContent.
    tmpFile = writeFixture([
      {
        type: 'message',
        id: 'r-num',
        timestamp: '2026-04-09T00:00:00Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_num', content: 42 }],
        },
      },
    ]);

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'toolu_num',
      content: '',
    });
  });

  it('parseTimestamp: falls back to Date.now() when timestamp is a number instead of a string', async () => {
    // The typeof guard in parseTimestamp returns Date.now() for non-string
    // values. This exercises the numeric case (e.g. Unix epoch ms) that
    // Droid might emit in a future schema revision.
    const beforeMs = Date.now();
    tmpFile = writeFixture([
      {
        type: 'message',
        id: 'u-numts',
        timestamp: 1712620800000, // a number, not a string
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'numeric timestamp' }],
        },
      },
    ]);
    const afterMs = Date.now();

    const entries = await parseDroidTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'numeric timestamp' });
    // `ts` should be a Date.now() fallback within the test window.
    const entryTs = (entries[0] as { kind: 'user'; uuid: string; ts: number; text: string }).ts;
    expect(entryTs).toBeGreaterThanOrEqual(beforeMs);
    expect(entryTs).toBeLessThanOrEqual(afterMs + 50); // 50ms tolerance
  });

  it('parses the real-shape fixture end-to-end', async () => {
    // Sanitized capture from a real Droid 0.109.1 session (read tool over
    // a sample.txt). Locks the parser against the actual on-disk schema:
    // any field-name drift in a future Droid version will fail this test.
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'droid-real-session.jsonl');
    const entries = await parseDroidTranscript(fixturePath);

    // Expected: user prompt -> assistant tool_use -> tool_result -> assistant final text
    // The session_start line is not surfaced as a transcript entry.
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);

    expect(entries[0]).toMatchObject({ kind: 'user' });
    expect((entries[0] as { kind: 'user'; text: string }).text).toContain('Read sample.txt');

    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      blocks: [{ type: 'tool_use', name: 'Read' }],
    });

    expect(entries[2]).toMatchObject({
      kind: 'tool_result',
      isError: false,
      content: 'hello world from fixture probe\n',
    });

    expect(entries[3]).toMatchObject({
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'hello world from fixture probe' }],
    });

    // The shared markdown formatter should pair the tool_result back under
    // its owning tool_use by id, even though they're separate entries.
    const md = transcriptToMarkdown(entries);
    expect(md).toContain('## User');
    expect(md).toContain('## Assistant');
    expect(md).toContain('**Tool:** `Read`');
    expect(md).toContain('"file_path"');
    expect(md).toContain('**Result:**');
    expect(md).toContain('hello world from fixture probe');
  });
});
