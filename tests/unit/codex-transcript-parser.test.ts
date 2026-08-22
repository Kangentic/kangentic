import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodexTranscript, locateCodexTranscriptFile } from '../../src/main/agent/adapters/codex/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

const SESSION_ID = '019df02a-e744-7de2-8f30-63d9ae3ab36a';

/** Enough `response_item` user turns to overflow `cap` several times over,
 *  each one identifiable by the index embedded in its text. `startIndex` lets
 *  a caller append a second, distinct batch to simulate the file growing. */
function buildOverCapLines(cap: number, startIndex = 0): { lines: object[]; lastLineIndex: number } {
  const lines: object[] = [];
  let written = 0;
  let lineIndex = startIndex;
  while (written <= cap * 3) {
    const fixtureLine = {
      type: 'response_item',
      timestamp: '2026-06-12T10:00:00Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `turn ${lineIndex} ${'q'.repeat(200)}` }] },
    };
    lines.push(fixtureLine);
    written += Buffer.byteLength(JSON.stringify(fixtureLine), 'utf-8') + 1;
    lineIndex += 1;
  }
  return { lines, lastLineIndex: lineIndex - 1 };
}

function writeFixture(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transcript-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

describe('parseCodexTranscript', () => {
  let tmpFile: string | null = null;
  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
      tmpFile = null;
    }
  });

  it('returns [] for a missing file', async () => {
    const entries = await parseCodexTranscript(SESSION_ID, path.join(os.tmpdir(), 'codex-missing.jsonl'));
    expect(entries).toEqual([]);
  });

  it('skips developer messages and injected user context wrappers', async () => {
    tmpFile = writeFixture([
      { type: 'response_item', timestamp: '2026-06-12T10:00:00Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>x' }] } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>C:/Users/dev/p</cwd>\n</environment_context>' }] } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real prompt' }] } },
    ]);
    const entries = await parseCodexTranscript(SESSION_ID, tmpFile);
    expect(entries).toEqual([
      { kind: 'user', uuid: expect.any(String), ts: expect.any(Number), text: 'real prompt' },
    ]);
  });

  it('drops empty (encrypted-only) reasoning and keeps populated summaries', async () => {
    tmpFile = writeFixture([
      { type: 'response_item', timestamp: '2026-06-12T10:00:00Z', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAA' } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:01Z', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan the work' }] } },
    ]);
    const entries = await parseCodexTranscript(SESSION_ID, tmpFile);
    expect(entries).toEqual([
      { kind: 'assistant', uuid: expect.any(String), ts: expect.any(Number), model: undefined, blocks: [{ type: 'thinking', text: 'plan the work' }] },
    ]);
  });

  it('maps function_call (parsed args) and function_call_output to a tool_use / tool_result pair', async () => {
    tmpFile = writeFixture([
      { type: 'turn_context', timestamp: '2026-06-12T10:00:00Z', payload: { model: 'gpt-5-codex' } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:01Z', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:02Z', payload: { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' } },
    ]);
    const entries = await parseCodexTranscript(SESSION_ID, tmpFile);
    expect(entries[0]).toMatchObject({ kind: 'assistant', model: 'gpt-5-codex', blocks: [{ type: 'tool_use', id: 'call_1', name: 'shell', input: { command: ['ls'] } }] });
    expect(entries[1]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_1', content: 'a.txt' });
  });

  it('parses only the tail of a transcript larger than the parse cap, marking the omission', async () => {
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const { lines, lastLineIndex } = buildOverCapLines(cap);
      tmpFile = writeFixture(lines);
      expect(fs.statSync(tmpFile).size).toBeGreaterThan(cap);

      const entries = await parseCodexTranscript(SESSION_ID, tmpFile);

      expect(entries.length).toBeLessThan(lines.length);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith('turn 0 '))).toBe(false);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith(`turn ${lastLineIndex} `))).toBe(true);

      expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
      // Absolute, so the surviving tail is numbered by its position in the
      // FILE, not renumbered from 0 within the window that was read.
      expect(entries[1].uuid).toBe(`${SESSION_ID}:${lines.length - entries.length + 1}`);
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('keeps a turnuuid stable when the transcript grows past the cap and the window slides', async () => {
    // The regression this guards: a window-relative counter reassigned a
    // different uuid to the same logical turn on every re-parse of a growing
    // over-cap transcript. Those uuids are the persisted citation anchors
    // (`memory_chunks.turn_uuid_start`), so they must survive the slide.
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const { lines } = buildOverCapLines(cap);
      tmpFile = writeFixture(lines);
      const before = await parseCodexTranscript(SESSION_ID, tmpFile);

      // Append only a couple of turns, so the window slides far enough to drop
      // the oldest but still overlaps the previous one. Appending a whole
      // window's worth would leave nothing in common and prove nothing.
      const appended = [0, 1].map((offset) => ({
        type: 'response_item',
        timestamp: '2026-06-12T10:00:00Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `turn ${lines.length + offset} ${'q'.repeat(200)}` }] },
      }));
      fs.writeFileSync(tmpFile, [...lines, ...appended].map((line) => JSON.stringify(line)).join('\n'));
      const after = await parseCodexTranscript(SESSION_ID, tmpFile);

      // The window slid: the oldest turn of the first parse is gone from the
      // second, which is what makes this a real test of the sliding case.
      const firstTurn = before.find((entry) => entry.kind === 'user');
      const lastTurnBefore = before[before.length - 1];
      expect(after.some((entry) => entry.uuid === firstTurn!.uuid)).toBe(false);

      // ...but a turn present in BOTH windows keeps the SAME uuid.
      const sameTurnAfter = after.find(
        (entry) => entry.kind === 'user' && lastTurnBefore.kind === 'user' && entry.text === lastTurnBefore.text,
      );
      expect(sameTurnAfter).toBeDefined();
      expect(sameTurnAfter!.uuid).toBe(lastTurnBefore.uuid);
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('namespaces uuids by session so two sessions on one task cannot collide', async () => {
    // `resolveTaskTranscript` stitches a task's sessions and dedups by uuid
    // keeping the first, so an unscoped `codex-0..N` made the second session's
    // turns disappear from the Conversation tab.
    tmpFile = writeFixture([
      { type: 'response_item', timestamp: '2026-06-12T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] } },
    ]);
    const one = await parseCodexTranscript('session-one', tmpFile);
    const two = await parseCodexTranscript('session-two', tmpFile);

    expect(one[0].uuid).toBe('session-one:0');
    expect(two[0].uuid).toBe('session-two:0');
    const overlap = one.map((entry) => entry.uuid).filter((uuid) => two.some((entry) => entry.uuid === uuid));
    expect(overlap).toEqual([]);
  });

  it('derives the uuid from the PHYSICAL line, counting lines it emits no entry for', async () => {
    // The exact string is the contract, not merely uniqueness or ordering:
    // these are persisted anchors, so a renumbering is a silent break. The
    // skipped `turn_context` and developer lines must still consume an index.
    tmpFile = writeFixture([
      { type: 'session_meta', timestamp: '2026-06-12T10:00:00Z', payload: { id: SESSION_ID } },
      { type: 'turn_context', timestamp: '2026-06-12T10:00:01Z', payload: { model: 'gpt-5-codex' } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:02Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'skipped' }] } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:03Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real prompt' }] } },
    ]);
    const entries = await parseCodexTranscript(SESSION_ID, tmpFile);
    expect(entries.map((entry) => entry.uuid)).toEqual([`${SESSION_ID}:3`]);
  });

  it('parses the pinned rollout fixture, ignoring duplicate event_msg entries', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'codex-real-rollout.jsonl');
    const entries = await parseCodexTranscript(SESSION_ID, fixturePath);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user', 'assistant', 'assistant', 'assistant', 'tool_result', 'assistant',
    ]);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'List the files in this directory.' });
    expect(entries[1]).toMatchObject({ blocks: [{ type: 'thinking', text: 'I should run a directory listing.' }] });
    expect(entries[3]).toMatchObject({ blocks: [{ type: 'tool_use', id: 'call_abc123', name: 'shell' }] });
    expect(entries[4]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_abc123', content: 'file1.txt\nfile2.txt' });

    // The uuid is the absolute PHYSICAL line, 0-indexed against the fixture
    // file. The lines with no corresponding entry above are still counted:
    // 0 session_meta, 1 turn_context, 2 the developer message, 3 the injected
    // environment_context wrapper, 5 the duplicate event_msg, 6 the empty
    // (encrypted-only) reasoning, and 11 the second duplicate event_msg.
    expect(entries.map((entry) => entry.uuid)).toEqual([
      `${SESSION_ID}:4`,
      `${SESSION_ID}:7`,
      `${SESSION_ID}:8`,
      `${SESSION_ID}:9`,
      `${SESSION_ID}:10`,
      `${SESSION_ID}:12`,
    ]);
  });
});

describe('locateCodexTranscriptFile', () => {
  it('returns null when no rollout matches the session id', () => {
    // A synthetic id that cannot exist on disk. Asserting null keeps the test
    // hermetic (no writes into the real ~/.codex/sessions tree).
    expect(locateCodexTranscriptFile('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
