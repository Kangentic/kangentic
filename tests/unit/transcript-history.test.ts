/**
 * The retrieval worker's history reads for the Conversation viewer
 * (`transcript-history.ts`): a page through the adapter's `readTranscriptPage`,
 * the archive when the agent's file is gone, the page holding a search hit, and
 * the timeline. Plus the extents `resolveTaskTranscript` reports, which the
 * viewer sizes its whole-transcript scrollbar from.
 *
 * Real pieces: Claude-format JSONL, the real Claude parser and page reader, the
 * real archive with Brotli, and a migrated better-sqlite3 database. The registry
 * is mocked so the adapter reads this test's files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(), get: vi.fn() },
}));

import { agentRegistry } from '../../src/main/agent/agent-registry';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import {
  TranscriptArchive,
  resetArchiveReadCacheForTests,
  type ArchiveAdapter,
} from '../../src/main/retrieval/archive/transcript-archive';
import {
  resolveTaskTranscript,
  resetForTests as resetTranscriptServiceForTests,
  setIndexedChunkReaderForTests,
} from '../../src/main/agent/transcript-service';
import {
  locateHistoryTurn,
  readHistoryPage,
  readHistoryTimeline,
  resetHistoryTimelinesForTests,
} from '../../src/main/agent/transcript-history';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import {
  parseClaudeTranscript,
  parseClaudeTranscriptWindow,
  readClaudeTranscriptPage,
  resetIncrementalParseStateForTests,
} from '../../src/main/agent/adapters/claude/transcript-parser';
import { openTestDatabase } from './helpers/test-database';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { TranscriptEntry, TranscriptHistoryPage, TranscriptPageResponse } from '../../src/shared/types';

const TAIL_BYTES = 1500;
const PAGE_BYTES = 900;
const ARCHIVE_WINDOW_BYTES = 800;
const AGENT_NAME = 'Claude Code';
const AGENT_SESSION_ID = 'agent-history-1';

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

function transcriptText(turns: number): string {
  let text = '';
  for (let turn = 0; turn < turns; turn += 1) {
    const timestamp = new Date(Date.UTC(2026, 8, 30, 12, turn, 0)).toISOString();
    text += `${JSON.stringify({ type: 'user', uuid: `user-${turn}`, timestamp, message: { role: 'user', content: `question ${turn}` } })}\n`;
    text += `${JSON.stringify({
      type: 'assistant', uuid: `assistant-${turn}`, timestamp,
      message: { id: `message-${turn}`, model: 'claude-test', content: [{ type: 'text', text: `answer ${turn} ${'detail '.repeat(8)}` }] },
    })}\n`;
  }
  return text;
}

interface Fixture {
  database: DatabaseType.Database;
  filePath: string;
  archive: TranscriptArchive;
}

function fixture(options: { turns: number; sessions?: Array<{ id: string; agentSessionId: string }> }): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-history-'));
  temporaryDirectories.push(directory);
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  const sessions = options.sessions ?? [{ id: 'session-1', agentSessionId: AGENT_SESSION_ID }];
  sessions.forEach((session, index) => {
    database.prepare(
      `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
       VALUES (?, 'task-1', 'claude_agent', ?, 'claude', '/work', 'suspended', ?)`,
    ).run(session.id, session.agentSessionId, new Date(Date.UTC(2026, 8, 30, 11, index)).toISOString());
  });

  const pathFor = (agentSessionId: string) => path.join(directory, `${agentSessionId}.jsonl`);
  const filePath = pathFor(AGENT_SESSION_ID);
  fs.writeFileSync(filePath, transcriptText(options.turns));

  const adapter = {
    displayName: AGENT_NAME,
    parseTranscript: async (agentSessionId: string) => ({
      entries: fs.existsSync(pathFor(agentSessionId)) ? await parseClaudeTranscript(pathFor(agentSessionId)) : [],
      sourcePath: pathFor(agentSessionId),
    }),
    readTranscriptPage: (agentSessionId: string, _cwd: string, request: Parameters<NonNullable<AgentAdapter['readTranscriptPage']>>[2]) =>
      readClaudeTranscriptPage(pathFor(agentSessionId), request),
  } as unknown as AgentAdapter;
  vi.mocked(agentRegistry.getBySessionType).mockImplementation(() => adapter);

  const archiveAdapter: ArchiveAdapter = {
    locateSessionHistoryFile: async (agentSessionId) => (fs.existsSync(pathFor(agentSessionId)) ? pathFor(agentSessionId) : null),
    parseTranscriptWindow: async (agentSessionId, _cwd, startByte, maxBytes, carry) => ({
      ...(await parseClaudeTranscriptWindow(pathFor(agentSessionId), startByte, maxBytes, carry)),
      sourcePath: pathFor(agentSessionId),
    }),
  };
  const archive = new TranscriptArchive({ getDb: () => database, getAdapter: () => archiveAdapter, windowBytes: ARCHIVE_WINDOW_BYTES });
  return { database, filePath, archive };
}

function pageOf(response: TranscriptPageResponse): TranscriptHistoryPage {
  if (response.status !== 'ok') throw new Error(`expected a page, got ${JSON.stringify(response)}`);
  return response;
}

function markerOf(entries: TranscriptEntry[]): { cursor: string; position: number } {
  const marker = entries.find((entry) => entry.kind === 'system' && entry.subtype === 'truncated');
  if (marker?.kind !== 'system' || !marker.earlierHistory) throw new Error('no pageable notice');
  return { cursor: marker.earlierHistory.cursor, position: marker.earlierHistory.position };
}

/** Walk back from a cursor to the start of the conversation, page by page. */
async function walkBack(database: DatabaseType.Database, cursor: string): Promise<TranscriptHistoryPage[]> {
  const pages: TranscriptHistoryPage[] = [];
  let next = cursor;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = pageOf(await readHistoryPage(database, {
      conversationId: AGENT_SESSION_ID, direction: 'before', cursor: next, maxBytes: PAGE_BYTES,
    }));
    pages.unshift(page);
    if (page.reachedStart) return pages;
    // Every step makes progress: the archive's off-by-one would stall here.
    expect(page.startPosition).toBeLessThan(page.endPosition);
    next = page.startCursor;
  }
  throw new Error('the walk never reached the start');
}

function withoutNotices(entries: TranscriptEntry[]): string[] {
  return entries.filter((entry) => !(entry.kind === 'system' && entry.subtype === 'truncated')).map((entry) => entry.uuid);
}

/** Every uuid once, in first-seen order: the viewer's merge dedupes the same way. */
function unique(uuids: string[]): string[] {
  return [...new Set(uuids)];
}

beforeEach(() => {
  resetArchiveReadCacheForTests();
  resetTranscriptServiceForTests();
  resetIncrementalParseStateForTests();
  resetHistoryTimelinesForTests();
  setIndexedChunkReaderForTests(async () => []);
  setParseWindowBytesForTests(TAIL_BYTES);
  vi.mocked(agentRegistry.getBySessionType).mockReset();
});

afterEach(() => {
  setParseWindowBytesForTests();
  resetIncrementalParseStateForTests();
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('readHistoryPage', () => {
  it('pages a live file back to its start, clamped, stamped with the agent and tiled with the tail', async () => {
    const { database, filePath } = fixture({ turns: 20 });
    const tail = await parseClaudeTranscript(filePath);
    const pages = await walkBack(database, markerOf(tail).cursor);

    const whole = (await parseClaudeTranscriptWindow(filePath, 0, 1 << 26)).entries.map((entry) => entry.uuid);
    expect(pages.flatMap((page) => page.entries.map((entry) => entry.uuid)).concat(withoutNotices(tail))).toEqual(whole);
    const assistant = pages[0].entries.find((entry) => entry.kind === 'assistant');
    expect(assistant?.kind === 'assistant' && assistant.agentName).toBe(AGENT_NAME);
    expect(pages[0].conversationId).toBe(AGENT_SESSION_ID);
  });

  it('pages a deleted file from the archive, from the archive tail\'s own cursor, with progress at every step', async () => {
    const { database, filePath, archive } = fixture({ turns: 20 });
    const whole = (await parseClaudeTranscriptWindow(filePath, 0, 1 << 26)).entries.map((entry) => entry.uuid);
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
    fs.rmSync(filePath);

    const resolved = await resolveTaskTranscript(database, 'session-1');
    expect(resolved?.source).toBe('archive');
    const pages = await walkBack(database, markerOf(resolved!.entries).cursor);
    expect(pages[0].sourceToken).toMatch(/^archive:/);
    const paged = pages.flatMap((page) => page.entries.map((entry) => entry.uuid)).concat(withoutNotices(resolved!.entries));
    expect(unique(paged)).toEqual(whole);
  });

  it('continues a live cursor against the archive once the file is gone', async () => {
    const { database, filePath, archive } = fixture({ turns: 20 });
    const whole = (await parseClaudeTranscriptWindow(filePath, 0, 1 << 26)).entries.map((entry) => entry.uuid);
    const liveTail = await parseClaudeTranscript(filePath);
    const liveCursor = markerOf(liveTail).cursor;
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
    fs.rmSync(filePath);

    const pages = await walkBack(database, liveCursor);
    const paged = pages.flatMap((page) => page.entries.map((entry) => entry.uuid)).concat(withoutNotices(liveTail));
    expect(unique(paged)).toEqual(whole);
  });

  it('answers not_found for a conversation no session names', async () => {
    const { database } = fixture({ turns: 4 });
    expect(await readHistoryPage(database, { conversationId: 'nobody', direction: 'before', cursor: 'j:10' }))
      .toEqual({ status: 'unavailable', reason: 'not_found' });
  });
});

describe('resolveTaskTranscript extents', () => {
  it('reports each conversation once, with its whole size and where its tail begins', async () => {
    const { database, filePath } = fixture({
      turns: 20,
      // A suspend and resume: two session rows over one agent session's file.
      sessions: [{ id: 'session-1', agentSessionId: AGENT_SESSION_ID }, { id: 'session-2', agentSessionId: AGENT_SESSION_ID }],
    });
    const resolved = await resolveTaskTranscript(database, 'session-2');
    expect(resolved?.conversations).toEqual([{
      conversationId: AGENT_SESSION_ID,
      totalPosition: fs.statSync(filePath).size,
      tailStartPosition: markerOf(resolved!.entries).position,
      pageable: true,
      hasTimestamps: true,
    }]);
    expect(resolved?.sessions.map((session) => session.agentSessionId)).toEqual([AGENT_SESSION_ID, AGENT_SESSION_ID]);

    // The stat-only fast path answers the same extents.
    const again = await resolveTaskTranscript(database, 'session-2');
    expect(again?.conversations).toEqual(resolved?.conversations);
  });
});

describe('readHistoryTimeline and locateHistoryTurn', () => {
  it('samples ascending positions and times over the whole file', async () => {
    const { database } = fixture({ turns: 30 });
    const timeline = await readHistoryTimeline(database, AGENT_SESSION_ID);
    if (timeline.status !== 'ok') throw new Error('no timeline');
    expect(timeline.samples.length).toBeGreaterThan(5);
    for (let index = 1; index < timeline.samples.length; index += 1) {
      expect(timeline.samples[index].position).toBeGreaterThan(timeline.samples[index - 1].position);
      expect(timeline.samples[index].ts).toBeGreaterThanOrEqual(timeline.samples[index - 1].ts);
    }
  });

  it('answers in_tail for a turn the tail holds and finds the page of an earlier one', async () => {
    const { database } = fixture({ turns: 30 });
    expect(await locateHistoryTurn(database, { sessionId: 'session-1', turnUuid: 'assistant-29' })).toEqual({ status: 'in_tail' });

    const byTime = await locateHistoryTurn(database, {
      sessionId: 'session-1', turnUuid: 'user-3', turnTs: Date.UTC(2026, 8, 30, 12, 3, 0),
    });
    expect(byTime.status).toBe('found');
    if (byTime.status === 'found') expect(byTime.page.entries.some((entry) => entry.uuid === 'user-3')).toBe(true);

    // With no time, the walk back from the tail still finds it.
    const byWalk = await locateHistoryTurn(database, { sessionId: 'session-1', turnUuid: 'user-1' });
    expect(byWalk.status).toBe('found');
  });

  it('takes a hit with only its uuid to the conversation and time its chunk records', async () => {
    const { database } = fixture({ turns: 30 });
    const insertChunk = (agentSessionId: string) => database.prepare(
      `INSERT INTO memory_chunks (doc_id, seq, session_id, task_id, agent_session_id, role, text, content_hash,
         token_estimate, ts_start, turn_uuid_start, created_at)
       VALUES (?, 0, 'session-1', 'task-1', ?, 'user', 'question 3', 'hash', 3, ?, 'user-3', ?)`,
    ).run(`doc-${agentSessionId}`, agentSessionId, Date.UTC(2026, 8, 30, 12, 3, 0), new Date().toISOString());

    // A chunk naming a conversation with no transcript is authoritative: the
    // task's own file is not walked, which shows the lookup was used at all.
    insertChunk('conversation-with-no-file');
    expect(await locateHistoryTurn(database, { sessionId: 'session-1', turnUuid: 'user-3' })).toEqual({ status: 'not_found' });

    database.prepare('DELETE FROM memory_chunks').run();
    insertChunk(AGENT_SESSION_ID);
    const found = await locateHistoryTurn(database, { sessionId: 'session-1', turnUuid: 'user-3' });
    expect(found.status === 'found' && found.page.entries.some((entry) => entry.uuid === 'user-3')).toBe(true);
  });

  it('answers not_found for a turn no conversation holds', async () => {
    const { database } = fixture({ turns: 10 });
    expect(await locateHistoryTurn(database, { sessionId: 'session-1', turnUuid: 'missing' })).toEqual({ status: 'not_found' });
  });
});
