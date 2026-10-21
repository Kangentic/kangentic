/**
 * Unit test for the OpenCode SQLite transcript parser.
 *
 * The SQLite I/O (`parseOpenCodeTranscriptAtPath`) reads rows through
 * better-sqlite3. The row-to-entry mapping is extracted into the pure
 * `mapOpenCodeRows`, which this test exercises directly with the verified
 * `message` / `part` row shapes, so no database is needed. The `tool` part
 * shape is schema-derived (no real tool parts were available locally).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  capOpenCodeRemoteEntries,
  mapOpenCodeRows,
  parseOpenCodeTranscriptAtPath,
  readOpenCodeTailAtPath,
  readOpenCodeTranscriptPage,
  type OpenCodeMessageRow,
  type OpenCodePartRow,
} from '../../src/main/agent/adapters/opencode/transcript-parser';
import { loadBetterSqlite3 } from '../../src/main/agent/adapters/opencode/session-history-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

function messageRow(id: string, timeCreated: number, data: object): OpenCodeMessageRow {
  return { id, time_created: timeCreated, data: JSON.stringify(data) };
}
function partRow(messageId: string, data: object): OpenCodePartRow {
  return { message_id: messageId, data: JSON.stringify(data) };
}

describe('mapOpenCodeRows', () => {
  it('maps user text, assistant reasoning/text/tool, and a paired tool_result', () => {
    const messages: OpenCodeMessageRow[] = [
      messageRow('m_user', 1000, { role: 'user' }),
      messageRow('m_asst', 2000, { role: 'assistant', modelID: 'big-pickle' }),
    ];
    const parts: OpenCodePartRow[] = [
      partRow('m_user', { type: 'text', text: 'List the files.' }),
      partRow('m_asst', { type: 'step-start' }),
      partRow('m_asst', { type: 'reasoning', text: 'I should list files.' }),
      partRow('m_asst', { type: 'text', text: 'Here are the files.' }),
      partRow('m_asst', { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'file1.txt' } }),
      partRow('m_asst', { type: 'step-finish' }),
    ];

    const entries = mapOpenCodeRows(messages, parts);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result']);
    expect(entries[0]).toMatchObject({ kind: 'user', uuid: 'm_user', ts: 1000, text: 'List the files.' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      model: 'big-pickle',
      blocks: [
        { type: 'thinking', text: 'I should list files.' },
        { type: 'text', text: 'Here are the files.' },
        { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
      ],
    });
    expect(entries[2]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_1', content: 'file1.txt', isError: false });
  });

  it('flags an error tool part via state.status', () => {
    const entries = mapOpenCodeRows(
      [messageRow('m', 1, { role: 'assistant' })],
      [partRow('m', { type: 'tool', callID: 'c', tool: 'bash', state: { status: 'error', output: 'failed' } })],
    );
    expect(entries.find((entry) => entry.kind === 'tool_result')).toMatchObject({ isError: true, content: 'failed' });
  });

  it('skips messages with no renderable parts', () => {
    const entries = mapOpenCodeRows(
      [messageRow('m', 1, { role: 'assistant' })],
      [partRow('m', { type: 'step-start' }), partRow('m', { type: 'step-finish' })],
    );
    expect(entries).toEqual([]);
  });
});

describe('parseOpenCodeTranscriptAtPath', () => {
  it('returns [] when the database file does not exist', () => {
    expect(parseOpenCodeTranscriptAtPath(path.join(os.tmpdir(), 'no-such-opencode.db'), 'ses_x')).toEqual([]);
  });
});

describe('the tail and history pages of a session', () => {
  const SESSION = 'ses_paged';
  let directory: string;
  let dbPath: string;

  /** A session of `turns` user and assistant messages, plus another session's rows that must never show. */
  function buildDatabase(turns: number): void {
    const DatabaseConstructor = loadBetterSqlite3();
    if (!DatabaseConstructor) throw new Error('better-sqlite3 should load in the unit tier');
    const database = new DatabaseConstructor(dbPath);
    database.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    database.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    const insertMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    const insertPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
    for (const session of [SESSION, 'ses_other']) {
      for (let turn = 0; turn < turns; turn += 1) {
        const time = 1_000 + turn * 10;
        const user = `${session}_m${String(turn).padStart(3, '0')}_user`;
        const assistant = `${session}_m${String(turn).padStart(3, '0')}_assistant`;
        insertMessage.run(user, session, time, time, JSON.stringify({ role: 'user' }));
        insertPart.run(`${user}_p0`, user, session, time, time, JSON.stringify({ type: 'text', text: `Question ${turn} ${'é'.repeat(turn % 7)}` }));
        insertMessage.run(assistant, session, time + 1, time + 1, JSON.stringify({ role: 'assistant', modelID: 'big-pickle' }));
        insertPart.run(`${assistant}_p0`, assistant, session, time + 1, time + 1, JSON.stringify({ type: 'step-start' }));
        insertPart.run(`${assistant}_p1`, assistant, session, time + 2, time + 2, JSON.stringify({ type: 'text', text: `Answer ${turn}` }));
        insertPart.run(`${assistant}_p2`, assistant, session, time + 3, time + 3, JSON.stringify({
          type: 'tool', callID: `call_${turn}`, tool: 'bash', state: { status: 'completed', input: { command: `ls ${turn}` }, output: `out ${turn}` },
        }));
      }
    }
    database.close();
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-page-'));
    dbPath = path.join(directory, 'opencode.db');
  });

  afterEach(() => {
    setParseWindowBytesForTests();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function okPage(result: ReturnType<typeof readOpenCodeTranscriptPage>) {
    if (result.status !== 'ok') throw new Error(`expected a page, got ${JSON.stringify(result)}`);
    return result.page;
  }

  it('reads a bounded tail behind a pageable notice, and the pages before it tile the session both ways', () => {
    buildDatabase(30);
    setParseWindowBytesForTests(64 * 1024 * 1024);
    const whole = readOpenCodeTailAtPath(dbPath, SESSION);
    expect(whole.entries.every((entry) => entry.origin?.conversationId === SESSION)).toBe(true);
    expect(whole.entries.some((entry) => entry.uuid.startsWith('ses_other'))).toBe(false);

    setParseWindowBytesForTests(1500);
    const tail = readOpenCodeTailAtPath(dbPath, SESSION);
    expect(tail.totalPosition).toBe(whole.totalPosition);
    const notice = tail.entries[0];
    if (notice.kind !== 'system' || !notice.earlierHistory) throw new Error('the tail should open with a pageable notice');
    expect(notice.earlierHistory.conversationId).toBe(SESSION);
    expect(tail.entries[1].origin?.position).toBe(notice.earlierHistory.position);

    const backward: Array<ReturnType<typeof okPage>> = [];
    let cursor = notice.earlierHistory.cursor;
    let expectedEnd = notice.earlierHistory.position;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = okPage(readOpenCodeTranscriptPage(dbPath, SESSION, { direction: 'before', cursor, maxBytes: 700 }));
      expect(page.endPosition).toBe(expectedEnd);
      backward.unshift(page);
      if (page.reachedStart) break;
      expect(page.startPosition).toBeLessThan(page.endPosition);
      expectedEnd = page.startPosition;
      cursor = page.startCursor;
    }
    expect(backward.flatMap((page) => page.entries).concat(tail.entries.slice(1))).toEqual(whole.entries);

    const forward: Array<ReturnType<typeof okPage>> = [];
    cursor = backward[0].startCursor;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = okPage(readOpenCodeTranscriptPage(dbPath, SESSION, {
        direction: 'after', cursor, maxBytes: 700, untilPosition: notice.earlierHistory.position,
      }));
      forward.push(page);
      if (page.reachedEnd) break;
      cursor = page.endCursor;
    }
    expect(forward.flatMap((page) => page.entries).concat(tail.entries.slice(1))).toEqual(whole.entries);
  });

  it('reads around a position, and answers reset for a cursor the session no longer has', () => {
    buildDatabase(30);
    setParseWindowBytesForTests(64 * 1024 * 1024);
    const whole = readOpenCodeTailAtPath(dbPath, SESSION);
    const middle = Math.floor(whole.totalPosition / 2);
    const around = okPage(readOpenCodeTranscriptPage(dbPath, SESSION, { direction: 'around', position: middle, maxBytes: 700 }));
    expect(around.startPosition).toBeLessThanOrEqual(middle);
    expect(around.endPosition).toBeGreaterThan(middle);
    expect(readOpenCodeTranscriptPage(dbPath, SESSION, { direction: 'before', cursor: 'o:1:gone', maxBytes: 700 })).toEqual({ status: 'reset' });
  });

  it('answers reset for a source token that names another session start, and accepts the token a page carries', () => {
    buildDatabase(30);
    const request = { direction: 'around' as const, position: 100, maxBytes: 700 };
    const page = okPage(readOpenCodeTranscriptPage(dbPath, SESSION, request));
    expect(page.sourceToken).toBe(`opencode:${SESSION}_m000_user`);

    expect(readOpenCodeTranscriptPage(dbPath, SESSION, { ...request, sourceToken: page.sourceToken }).status).toBe('ok');
    expect(readOpenCodeTranscriptPage(dbPath, SESSION, { ...request, sourceToken: 'opencode:other' })).toEqual({ status: 'reset' });
  });

  it.each(['before', 'after'] as const)('answers reset, not a failed read, for a %s cursor with a malformed escape', (direction) => {
    buildDatabase(30);
    // `decodeURIComponent` throws a URIError on this; it used to surface as file_missing.
    expect(readOpenCodeTranscriptPage(dbPath, SESSION, { direction, cursor: 'o:1:%E0%A4%A', maxBytes: 700 })).toEqual({ status: 'reset' });
  });

  it('answers file_missing for a database that is not there and read_failed for a file that is not a database', () => {
    const request = { direction: 'around' as const, position: 0, maxBytes: 700 };
    expect(readOpenCodeTranscriptPage(path.join(directory, 'no-such-opencode.db'), SESSION, request))
      .toEqual({ status: 'unavailable', reason: 'file_missing' });

    // Over a kilobyte of text no SQLite header would start with.
    const notDatabase = path.join(directory, 'not-a-database.db');
    fs.writeFileSync(notDatabase, 'this file is plain text, not a database\n'.repeat(100));
    expect(fs.statSync(notDatabase).size).toBeGreaterThan(1024);
    expect(readOpenCodeTranscriptPage(notDatabase, SESSION, request)).toEqual({ status: 'unavailable', reason: 'read_failed' });
  });

  it('bounds a remote session to the newest entries behind a notice with no cursor', () => {
    setParseWindowBytesForTests(400);
    const entries = Array.from({ length: 20 }, (_, index) => ({ kind: 'user' as const, uuid: `m${index}`, ts: index, text: `turn ${index}` }));
    const capped = capOpenCodeRemoteEntries(entries);
    expect(capped[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
    expect(capped[0].kind === 'system' && capped[0].earlierHistory).toBeFalsy();
    expect(capped[capped.length - 1].uuid).toBe('m19');
    expect(capped.length).toBeLessThan(entries.length);
  });
});
