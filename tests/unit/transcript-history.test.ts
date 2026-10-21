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
import type { TranscriptEntry, TranscriptHistoryPage, TranscriptPageResponse, TranscriptTimelineResponse } from '../../src/shared/types';

const TAIL_BYTES = 1500;
const PAGE_BYTES = 900;
const ARCHIVE_WINDOW_BYTES = 800;
const AGENT_NAME = 'Claude Code';
const AGENT_SESSION_ID = 'agent-history-1';

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

/** `turns` turns, numbered from `firstTurn`: a turn's minute is its number, so keep them under 60. */
function transcriptText(turns: number, firstTurn = 0): string {
  let text = '';
  for (let turn = firstTurn; turn < firstTurn + turns; turn += 1) {
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

  it('answers reset for an archive token the archive no longer holds, and takes a live token onto the archive', async () => {
    const { database, filePath, archive } = fixture({ turns: 20 });
    const liveTail = await parseClaudeTranscript(filePath);
    const liveToken = pageOf(await readHistoryPage(database, {
      conversationId: AGENT_SESSION_ID, direction: 'before', cursor: markerOf(liveTail).cursor, maxBytes: PAGE_BYTES,
    })).sourceToken;
    expect(liveToken).toMatch(/^jsonl:/);
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
    fs.rmSync(filePath);

    const resolved = await resolveTaskTranscript(database, 'session-1');
    expect(resolved?.source).toBe('archive');
    const request = { conversationId: AGENT_SESSION_ID, direction: 'before' as const, cursor: markerOf(resolved!.entries).cursor, maxBytes: PAGE_BYTES };
    const first = pageOf(await readHistoryPage(database, request));
    expect(first.sourceToken).toMatch(/^archive:/);

    // The page's own token is the archive it was read from, so it is no reset.
    expect((await readHistoryPage(database, { ...request, sourceToken: first.sourceToken })).status).toBe('ok');
    // An archive token the archive does not carry is a rewrite under the caller.
    expect(await readHistoryPage(database, { ...request, sourceToken: 'archive:stale' }))
      .toEqual({ status: 'reset', conversationId: AGENT_SESSION_ID });
    // A live file's pages and the archive share one byte space, so the file going
    // away between two pages is not a reset.
    expect((await readHistoryPage(database, { ...request, sourceToken: liveToken })).status).toBe('ok');
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

  it('reports a pageable extent for a conversation read from the archive, sized by the file it archived', async () => {
    const { database, filePath, archive } = fixture({ turns: 20 });
    const archivedBytes = fs.statSync(filePath).size;
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
    fs.rmSync(filePath);

    const resolved = await resolveTaskTranscript(database, 'session-1');
    expect(resolved?.source).toBe('archive');
    const notice = markerOf(resolved!.entries);
    // The tail is bounded, so the notice is there and the archive holds more than it shows.
    expect(notice.position).toBeGreaterThan(0);
    expect(resolved?.conversations).toEqual([{
      conversationId: AGENT_SESSION_ID,
      totalPosition: archivedBytes,
      tailStartPosition: notice.position,
      pageable: true,
      hasTimestamps: true,
    }]);
  });

  it('reports the same archive extent when the adapter has no structured parser', async () => {
    // `resolveSessionTranscript` reaches the archive by a second route when the
    // adapter cannot parse a transcript: the conversation is named by its agent
    // session id and the extent is built the same way.
    const { database, filePath, archive } = fixture({ turns: 20 });
    const adapter = agentRegistry.getBySessionType('claude_agent');
    vi.mocked(agentRegistry.getBySessionType).mockImplementation(
      () => ({ ...adapter, parseTranscript: undefined }) as unknown as AgentAdapter,
    );
    const archivedBytes = fs.statSync(filePath).size;
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
    fs.rmSync(filePath);

    const resolved = await resolveTaskTranscript(database, 'session-1');
    expect(resolved?.source).toBe('archive');
    expect(resolved?.conversations).toEqual([{
      conversationId: AGENT_SESSION_ID,
      totalPosition: archivedBytes,
      tailStartPosition: markerOf(resolved!.entries).position,
      pageable: true,
      hasTimestamps: true,
    }]);
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

  it('checks a cached timeline with a probe-sized read, never a tiny one', async () => {
    // A page skips every line longer than itself, so a 1-byte check walked the
    // whole file a byte at a time; on a 97 MB transcript that held the worker's
    // history queue until main killed the worker.
    const { database } = fixture({ turns: 30 });
    const adapter = agentRegistry.getBySessionType('claude_agent');
    if (!adapter?.readTranscriptPage) throw new Error('no adapter');
    const readPage = vi.spyOn(adapter, 'readTranscriptPage');
    const first = await readHistoryTimeline(database, AGENT_SESSION_ID);
    const cachedReadsFrom = readPage.mock.calls.length;
    const second = await readHistoryTimeline(database, AGENT_SESSION_ID);
    expect(second).toEqual(first);
    // The second answer came from the cache: one check, not another 64 probes.
    expect(readPage.mock.calls.length - cachedReadsFrom).toBe(1);
    for (const [, , request] of readPage.mock.calls) expect(request.maxBytes).toBeGreaterThanOrEqual(1024);
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

describe('readHistoryTimeline build, reuse and deadline', () => {
  /** The fixture adapter, with its page read spied on (the spy calls through). */
  function spyOnPageReads() {
    const adapter = agentRegistry.getBySessionType('claude_agent');
    if (!adapter?.readTranscriptPage) throw new Error('no adapter');
    return vi.spyOn(adapter, 'readTranscriptPage');
  }

  function samplesOf(timeline: TranscriptTimelineResponse): Array<{ position: number; ts: number }> {
    if (timeline.status !== 'ok') throw new Error(`expected a timeline, got ${JSON.stringify(timeline)}`);
    return timeline.samples;
  }

  it('answers unsupported_agent, reading nothing, for an adapter whose transcript carries no timestamps', async () => {
    const { database } = fixture({ turns: 30 });
    // The same conversation has a timeline while its adapter dates its entries.
    expect((await readHistoryTimeline(database, AGENT_SESSION_ID)).status).toBe('ok');

    const adapter = agentRegistry.getBySessionType('claude_agent');
    const withoutTimestamps = { ...adapter, transcriptHasTimestamps: false } as unknown as AgentAdapter;
    const readPage = vi.spyOn(withoutTimestamps, 'readTranscriptPage');
    vi.mocked(agentRegistry.getBySessionType).mockImplementation(() => withoutTimestamps);
    expect(await readHistoryTimeline(database, AGENT_SESSION_ID)).toEqual({ status: 'unavailable', reason: 'unsupported_agent' });
    expect(readPage).not.toHaveBeenCalled();
  });

  it('passes probe: true on every probe read and on the cache check', async () => {
    const { database } = fixture({ turns: 30 });
    const readPage = spyOnPageReads();
    await readHistoryTimeline(database, AGENT_SESSION_ID);
    const probeReads = readPage.mock.calls.length;
    expect(probeReads).toBeGreaterThan(1);
    await readHistoryTimeline(database, AGENT_SESSION_ID);
    // The second answer came from the cache after exactly one check read, which
    // is the one call carrying the cached source's token.
    expect(readPage.mock.calls.length - probeReads).toBe(1);
    expect(readPage.mock.calls.filter(([, , request]) => request.sourceToken !== undefined)).toHaveLength(1);
    for (const [, , request] of readPage.mock.calls) {
      expect(request.direction).toBe('around');
      expect(request.probe).toBe(true);
    }
  });

  it('reuses a timeline until its source has grown by a quarter, then rebuilds it out to the new end', async () => {
    const { database, filePath } = fixture({ turns: 30 });
    const readPage = spyOnPageReads();
    const first = samplesOf(await readHistoryTimeline(database, AGENT_SESSION_ID));
    const builtAtSize = fs.statSync(filePath).size;

    // Three turns on thirty is about a tenth: the cached map stands, after one check.
    fs.appendFileSync(filePath, transcriptText(3, 30));
    expect(fs.statSync(filePath).size).toBeLessThan(builtAtSize * 1.25);
    let readsBefore = readPage.mock.calls.length;
    expect(samplesOf(await readHistoryTimeline(database, AGENT_SESSION_ID))).toEqual(first);
    expect(readPage.mock.calls.length - readsBefore).toBe(1);

    // Fifteen turns on thirty is half again: the map is built over, probe by probe.
    fs.appendFileSync(filePath, transcriptText(12, 33));
    expect(fs.statSync(filePath).size).toBeGreaterThanOrEqual(builtAtSize * 1.25);
    readsBefore = readPage.mock.calls.length;
    const rebuilt = samplesOf(await readHistoryTimeline(database, AGENT_SESSION_ID));
    expect(readPage.mock.calls.length - readsBefore).toBeGreaterThan(1);
    // Dated entries from the appended region are on the map, which the old one could not hold.
    expect(rebuilt.some((sample) => sample.position >= builtAtSize)).toBe(true);
    expect(rebuilt[rebuilt.length - 1].position).toBeGreaterThan(first[first.length - 1].position);
    expect(rebuilt[rebuilt.length - 1].ts).toBeGreaterThan(first[first.length - 1].ts);

    // The rebuild is the cached map now.
    readsBefore = readPage.mock.calls.length;
    expect(samplesOf(await readHistoryTimeline(database, AGENT_SESSION_ID))).toEqual(rebuilt);
    expect(readPage.mock.calls.length - readsBefore).toBe(1);
  });

  it('stops probing at a deadline already past and probes again on the next call', async () => {
    const { database } = fixture({ turns: 30 });
    const readPage = spyOnPageReads();
    const cut = samplesOf(await readHistoryTimeline(database, AGENT_SESSION_ID, Date.now() - 1));
    // No probe, and no cached map to check: only the tail's own first dated entry is on it.
    expect(readPage).not.toHaveBeenCalled();
    expect(cut.length).toBeLessThanOrEqual(1);

    const full = samplesOf(await readHistoryTimeline(database, AGENT_SESSION_ID));
    expect(readPage.mock.calls.length).toBeGreaterThan(1);
    expect(full.length).toBeGreaterThan(5);
  });

  it('answers the samples a build cut short by its deadline has, and does not cache them', async () => {
    const { database, filePath } = fixture({ turns: 30 });
    const readPage = spyOnPageReads();
    // Only Date is faked, and only between reads, so the deadline falls partway through the probes.
    let advancing = true;
    readPage.mockImplementation(async (_agentSessionId, _cwd, request) => {
      if (advancing) vi.setSystemTime(Date.now() + 10);
      return readClaudeTranscriptPage(filePath, request);
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    let cut: Array<{ position: number; ts: number }>;
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 1)));
      cut = samplesOf(await readHistoryTimeline(database, AGENT_SESSION_ID, Date.now() + 25));
    } finally {
      advancing = false;
      vi.useRealTimers();
    }
    // Some probes ran, so the map has samples, but not all of them did.
    expect(readPage.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readPage.mock.calls.length).toBeLessThan(10);
    expect(cut.length).toBeGreaterThanOrEqual(1);

    // A cached partial map would be checked with one read and answered as it is.
    readPage.mockClear();
    const full = samplesOf(await readHistoryTimeline(database, AGENT_SESSION_ID));
    expect(readPage.mock.calls.length).toBeGreaterThan(10);
    expect(full.length).toBeGreaterThan(cut.length);
  });
});
