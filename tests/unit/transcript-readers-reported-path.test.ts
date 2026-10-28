/**
 * The transcript readers hand the agent-reported transcript path to the adapter.
 *
 * `AgentAdapter.locateSessionHistoryFile`, `parseTranscript`,
 * `parseTranscriptWindow` and `readTranscriptPage` take it as an optional
 * trailing `reportedPath`: the file the agent said it is writing, which can be
 * outside the folder its cwd maps to. A reader fills it from the session row's
 * `transcript_path` (history pages and timeline) or from the facts object a
 * caller builds (`transcriptPath`: message trail, final reply, and the worker
 * methods that carry those facts). A reader that drops it reads the wrong file
 * for a resumed conversation. The existing reader tests pass null, so a dropped
 * argument goes unnoticed. Here every adapter records its arguments.
 *
 * Covered, in order:
 *   1. `transcript-history.ts`: `readHistoryPage` and `readHistoryTimeline`.
 *   2. `message-trail-read.ts`: `readTrail` and `readFinalReply`.
 *   3. the worker methods `transcript.trailRead` and `transcript.finalReply`.
 *   4. `message-trail-tracker.ts`: the path arrives on a later row lookup than
 *      the id, and is adopted only for the same conversation.
 *
 * The agent registry is spied so the readers resolve the recording adapter. Files
 * are written under a temp folder only.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import type { AgentAdapter, ParsedTranscript, ParsedTranscriptWindow } from '../../src/main/agent/agent-adapter';
import {
  readHistoryPage,
  readHistoryTimeline,
  resetHistoryTimelinesForTests,
} from '../../src/main/agent/transcript-history';
import {
  resetForTests as resetTranscriptServiceForTests,
  setIndexedChunkReaderForTests,
} from '../../src/main/agent/transcript-service';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import {
  parseClaudeTranscript,
  readClaudeTranscriptPage,
  resetIncrementalParseStateForTests,
} from '../../src/main/agent/adapters/claude/transcript-parser';
import { resetArchiveReadCacheForTests } from '../../src/main/retrieval/archive/transcript-archive';
import { readFinalReply, readTrail, type MessageTrailAdapter } from '../../src/main/agent/message-trail-read';
import {
  MessageTrailTracker,
  type MessageTrailReadFacts,
  type MessageTrailSessionFacts,
  type MessageTrailTrackerDeps,
} from '../../src/main/agent/message-trail-tracker';
import { transcriptHandlers } from '../../src/main/retrieval/worker/transcript-methods';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';
import { openTestDatabase } from './helpers/test-database';
import type { Session } from '../../src/shared/types';

type PageArguments = Parameters<NonNullable<AgentAdapter['readTranscriptPage']>>;
type LocateArguments = Parameters<AgentAdapter['locateSessionHistoryFile']>;
type WindowArguments = Parameters<NonNullable<AgentAdapter['parseTranscriptWindow']>>;
type WholeFileArguments = Parameters<NonNullable<AgentAdapter['parseTranscript']>>;

/** Where `reportedPath` sits in each recorded call. */
const PAGE_REPORTED_PATH_INDEX = 4;
const LOCATE_REPORTED_PATH_INDEX = 3;
const WINDOW_REPORTED_PATH_INDEX = 6;
const WHOLE_FILE_REPORTED_PATH_INDEX = 3;

const REPORTED_PATH = path.join(os.tmpdir(), 'kangentic-reported-path-readers', 'reported', 'agent-1.jsonl');
const AGENT_SESSION_ID = 'agent-session-1';
const TRANSCRIPT_BYTES = 4096;

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  setParseWindowBytesForTests();
  resetIncrementalParseStateForTests();
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-readers-reported-path-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** The distinct values the calls carried at `index`: empty when nothing was called. */
function distinctAt(calls: ReadonlyArray<ReadonlyArray<unknown>>, index: number): unknown[] {
  return [...new Set(calls.map((args) => args[index]))];
}

// ---------------------------------------------------------------------------
// 1. transcript-history.ts: the page read and the timeline
// ---------------------------------------------------------------------------

const TAIL_BYTES = 1500;
const PAGE_BYTES = 900;

/** `turns` Claude-format turns, one user and one assistant line each; a turn's minute is its number. */
function claudeTranscriptText(turns: number): string {
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

interface HistoryFixture {
  database: DatabaseType.Database;
  pageCalls: PageArguments[];
}

/**
 * A migrated project with one session row (`transcriptPath` as its status line
 * reported it) over a real Claude-format file. The adapter reads that file
 * through the real page reader and records every `readTranscriptPage` call.
 */
function historyFixture(transcriptPath: string | null): HistoryFixture {
  const filePath = path.join(temporaryDirectory(), `${AGENT_SESSION_ID}.jsonl`);
  fs.writeFileSync(filePath, claudeTranscriptText(30));

  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  database.prepare(
    `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at, transcript_path)
     VALUES ('session-1', 'task-1', 'claude_agent', ?, 'claude', '/work', 'suspended', '2026-09-30T11:00:00.000Z', ?)`,
  ).run(AGENT_SESSION_ID, transcriptPath);

  const pageCalls: PageArguments[] = [];
  const adapter = {
    displayName: 'Claude Code',
    parseTranscript: async (): Promise<ParsedTranscript> => ({ entries: await parseClaudeTranscript(filePath), sourcePath: filePath }),
    readTranscriptPage: async (...args: PageArguments) => {
      pageCalls.push(args);
      return readClaudeTranscriptPage(filePath, args[2]);
    },
  };
  vi.spyOn(agentRegistry, 'getBySessionType').mockImplementation(() => adapter as unknown as AgentAdapter);
  return { database, pageCalls };
}

describe('transcript-history hands the row\'s reported path to readTranscriptPage', () => {
  beforeEach(() => {
    resetArchiveReadCacheForTests();
    resetTranscriptServiceForTests();
    resetIncrementalParseStateForTests();
    resetHistoryTimelinesForTests();
    setIndexedChunkReaderForTests(async () => []);
    setParseWindowBytesForTests(TAIL_BYTES);
  });

  it('readHistoryPage passes the path with the page read', async () => {
    const { database, pageCalls } = historyFixture(REPORTED_PATH);

    const response = await readHistoryPage(database, { conversationId: AGENT_SESSION_ID, direction: 'around', position: 0, maxBytes: PAGE_BYTES });

    expect(response.status).toBe('ok');
    expect(pageCalls).toHaveLength(1);
    expect(pageCalls[0][PAGE_REPORTED_PATH_INDEX]).toBe(REPORTED_PATH);
  });

  it('readHistoryPage passes null, not a missing argument, for a row that reported no path', async () => {
    const { database, pageCalls } = historyFixture(null);

    await readHistoryPage(database, { conversationId: AGENT_SESSION_ID, direction: 'around', position: 0, maxBytes: PAGE_BYTES });

    expect(pageCalls).toHaveLength(1);
    expect(pageCalls[0][PAGE_REPORTED_PATH_INDEX]).toBeNull();
  });

  it('readHistoryTimeline passes the path with every probe of a build', async () => {
    const { database, pageCalls } = historyFixture(REPORTED_PATH);

    const timeline = await readHistoryTimeline(database, AGENT_SESSION_ID);

    expect(timeline.status).toBe('ok');
    // 64 probes, not one: the loop reads more than once.
    expect(pageCalls.length).toBeGreaterThan(1);
    expect(distinctAt(pageCalls, PAGE_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });

  it('readHistoryTimeline passes the path with the one check read that validates a cached timeline', async () => {
    const { database, pageCalls } = historyFixture(REPORTED_PATH);
    await readHistoryTimeline(database, AGENT_SESSION_ID);
    const readsToBuild = pageCalls.length;

    const cached = await readHistoryTimeline(database, AGENT_SESSION_ID);

    expect(cached.status).toBe('ok');
    const checkReads = pageCalls.slice(readsToBuild);
    expect(checkReads).toHaveLength(1);
    // It is the check read: it carries the cached source's token.
    expect(checkReads[0][2].sourceToken).toBeDefined();
    expect(checkReads[0][PAGE_REPORTED_PATH_INDEX]).toBe(REPORTED_PATH);
  });

  it('readHistoryTimeline passes null on every read for a row that reported no path', async () => {
    const { database, pageCalls } = historyFixture(null);

    await readHistoryTimeline(database, AGENT_SESSION_ID);
    await readHistoryTimeline(database, AGENT_SESSION_ID);

    expect(pageCalls.length).toBeGreaterThan(2);
    expect(distinctAt(pageCalls, PAGE_REPORTED_PATH_INDEX)).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// 2. message-trail-read.ts: readTrail and readFinalReply
// ---------------------------------------------------------------------------

interface TrailAdapterCalls {
  locate: LocateArguments[];
  window: WindowArguments[];
  wholeFile: WholeFileArguments[];
}

interface TrailFixture {
  adapter: MessageTrailAdapter;
  calls: TrailAdapterCalls;
}

/**
 * An adapter over a real file of `TRANSCRIPT_BYTES`, recording every argument.
 * `windowed` gives it the windowed walk (one window that reaches the end);
 * without it the adapter has only `parseTranscript`, like one with no window read.
 */
function trailFixture(options: { windowed: boolean }): TrailFixture {
  const filePath = path.join(temporaryDirectory(), `${AGENT_SESSION_ID}.jsonl`);
  fs.writeFileSync(filePath, 'x'.repeat(TRANSCRIPT_BYTES));
  const calls: TrailAdapterCalls = { locate: [], window: [], wholeFile: [] };
  const locate = async (...args: LocateArguments): Promise<string | null> => {
    calls.locate.push(args);
    return filePath;
  };
  const adapter: MessageTrailAdapter = options.windowed
    ? {
        locateSessionHistoryFile: locate,
        parseTranscriptWindow: async (...args: WindowArguments): Promise<ParsedTranscriptWindow> => {
          calls.window.push(args);
          return { entries: [], sourcePath: filePath, nextByteOffset: TRANSCRIPT_BYTES, totalBytes: TRANSCRIPT_BYTES, firstByteOffset: 0, endByte: TRANSCRIPT_BYTES };
        },
      }
    : {
        locateSessionHistoryFile: locate,
        parseTranscript: async (...args: WholeFileArguments): Promise<ParsedTranscript> => {
          calls.wholeFile.push(args);
          // No source path, so the transcript cache keeps nothing between tests.
          return { entries: [], sourcePath: null };
        },
      };
  return { adapter, calls };
}

/** Unique per test, so the transcript cache (keyed by session type and id) never answers a later test's read. */
let factsCounter = 0;
function trailFacts(transcriptPath: string | null | undefined): MessageTrailReadFacts {
  factsCounter += 1;
  return {
    sessionType: `reported_path_agent_${factsCounter}`,
    agentSessionId: AGENT_SESSION_ID,
    cwd: '/mock/project',
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
  };
}

describe('message-trail-read hands facts.transcriptPath to the adapter', () => {
  it('readTrail passes it to the locate and to every window of a first read', async () => {
    const { adapter, calls } = trailFixture({ windowed: true });

    await readTrail(adapter, trailFacts(REPORTED_PATH), null);

    expect(distinctAt(calls.locate, LOCATE_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
    expect(distinctAt(calls.window, WINDOW_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });

  it('readTrail passes it to the window of a later read from a cursor', async () => {
    const { adapter, calls } = trailFixture({ windowed: true });

    await readTrail(adapter, trailFacts(REPORTED_PATH), 100);

    expect(calls.window.length).toBeGreaterThan(0);
    expect(distinctAt(calls.window, WINDOW_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });

  it('readTrail passes it to parseTranscript on an adapter with only the whole-file parse', async () => {
    const { adapter, calls } = trailFixture({ windowed: false });

    const trail = await readTrail(adapter, trailFacts(REPORTED_PATH), null);

    expect(trail.usedFallback).toBe(true);
    expect(distinctAt(calls.wholeFile, WHOLE_FILE_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });

  it('readTrail passes null, not a missing argument, when the facts carry no path', async () => {
    const windowed = trailFixture({ windowed: true });
    await readTrail(windowed.adapter, trailFacts(undefined), null);
    expect(distinctAt(windowed.calls.locate, LOCATE_REPORTED_PATH_INDEX)).toEqual([null]);
    expect(distinctAt(windowed.calls.window, WINDOW_REPORTED_PATH_INDEX)).toEqual([null]);

    const wholeFile = trailFixture({ windowed: false });
    await readTrail(wholeFile.adapter, trailFacts(null), null);
    expect(distinctAt(wholeFile.calls.wholeFile, WHOLE_FILE_REPORTED_PATH_INDEX)).toEqual([null]);
  });

  it('readFinalReply passes it to the locate that finds an anchored read\'s start, and to the windows', async () => {
    const { adapter, calls } = trailFixture({ windowed: true });
    const facts = trailFacts(REPORTED_PATH);

    await readFinalReply(adapter, facts, { agentSessionId: facts.agentSessionId, byteOffset: 100 });

    // An anchored read starts at the anchor, so the only locate is the one that sizes the file for it.
    expect(calls.locate).toHaveLength(1);
    expect(calls.locate[0][LOCATE_REPORTED_PATH_INDEX]).toBe(REPORTED_PATH);
    expect(distinctAt(calls.window, WINDOW_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });

  it('readFinalReply passes it to the locate and the windows of an unanchored tail read', async () => {
    const { adapter, calls } = trailFixture({ windowed: true });

    await readFinalReply(adapter, trailFacts(REPORTED_PATH), null);

    expect(distinctAt(calls.locate, LOCATE_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
    expect(distinctAt(calls.window, WINDOW_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });

  it('readFinalReply passes it to parseTranscript on an adapter with only the whole-file parse', async () => {
    const { adapter, calls } = trailFixture({ windowed: false });

    await readFinalReply(adapter, trailFacts(REPORTED_PATH), null);

    expect(distinctAt(calls.wholeFile, WHOLE_FILE_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });

  it('readFinalReply passes null, not a missing argument, when the facts carry no path', async () => {
    const { adapter, calls } = trailFixture({ windowed: true });
    const facts = trailFacts(undefined);

    await readFinalReply(adapter, facts, { agentSessionId: facts.agentSessionId, byteOffset: 100 });

    expect(calls.locate).toHaveLength(1);
    expect(calls.locate[0][LOCATE_REPORTED_PATH_INDEX]).toBeNull();
    expect(distinctAt(calls.window, WINDOW_REPORTED_PATH_INDEX)).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// 3. the worker methods that carry those facts
// ---------------------------------------------------------------------------

describe('the worker methods forward facts.transcriptPath into the adapter', () => {
  /** The handlers read nothing from their context. */
  const context: WorkerContext = {
    getDb: () => ({}) as unknown as DatabaseType.Database,
    closeDb: () => undefined,
    vecLoadError: () => null,
    emit: () => undefined,
  };

  function resolveAdapter(adapter: MessageTrailAdapter): void {
    vi.spyOn(agentRegistry, 'getBySessionType').mockImplementation(() => adapter as unknown as AgentAdapter);
  }

  it('transcript.trailRead reaches the locate and the windows of the read', async () => {
    const { adapter, calls } = trailFixture({ windowed: true });
    resolveAdapter(adapter);

    await transcriptHandlers['transcript.trailRead']({ facts: trailFacts(REPORTED_PATH), cursor: null, remoteTargets: [] }, context);

    expect(distinctAt(calls.locate, LOCATE_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
    expect(distinctAt(calls.window, WINDOW_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });

  it('transcript.finalReply reaches the anchored read\'s locate and the windows', async () => {
    const { adapter, calls } = trailFixture({ windowed: true });
    resolveAdapter(adapter);
    const facts = trailFacts(REPORTED_PATH);

    await transcriptHandlers['transcript.finalReply'](
      { facts, since: { agentSessionId: facts.agentSessionId, byteOffset: 100 }, remoteTargets: [] },
      context,
    );

    expect(calls.locate).toHaveLength(1);
    expect(calls.locate[0][LOCATE_REPORTED_PATH_INDEX]).toBe(REPORTED_PATH);
    expect(distinctAt(calls.window, WINDOW_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });

  it('transcript.finalReply reaches a whole-file adapter\'s parse', async () => {
    const { adapter, calls } = trailFixture({ windowed: false });
    resolveAdapter(adapter);

    await transcriptHandlers['transcript.finalReply']({ facts: trailFacts(REPORTED_PATH), remoteTargets: [] }, context);

    expect(distinctAt(calls.wholeFile, WHOLE_FILE_REPORTED_PATH_INDEX)).toEqual([REPORTED_PATH]);
  });
});

// ---------------------------------------------------------------------------
// 4. message-trail-tracker.ts: the path arrives after the id
// ---------------------------------------------------------------------------

class FakeSessionManager extends EventEmitter {
  readonly sessions = new Map<string, Session>();

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }
}

function fakeSession(id: string): Session {
  return {
    id,
    taskId: `task-${id}`,
    projectId: 'project-1',
    pid: 4242,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-06-01T00:00:00.000Z',
    exitCode: null,
    resuming: false,
    agentSessionId: `agent-${id}`,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('MessageTrailTracker reads the reported path off the row once it lands', () => {
  const MIN_INTERVAL_MS = 20;
  const OTHER_REPORTED_PATH = path.join(os.tmpdir(), 'kangentic-reported-path-readers', 'reported', 'agent-2.jsonl');
  const WITHOUT_PATH: MessageTrailSessionFacts = { sessionType: 'tracker_agent', agentSessionId: 'agent-1', cwd: '/mock/project' };

  let manager: FakeSessionManager;
  let tracker: MessageTrailTracker | null;
  let resolveSessionFacts: ReturnType<typeof vi.fn<MessageTrailTrackerDeps['resolveSessionFacts']>>;
  let readTrailCalls: ReturnType<typeof vi.fn<MessageTrailTrackerDeps['readTrail']>>;

  beforeEach(() => {
    manager = new FakeSessionManager();
    manager.sessions.set('s1', fakeSession('s1'));
    tracker = null;
    resolveSessionFacts = vi.fn<MessageTrailTrackerDeps['resolveSessionFacts']>();
    readTrailCalls = vi.fn<MessageTrailTrackerDeps['readTrail']>(async (_facts, cursor) => ({ previews: [], cursor, usedFallback: false }));
  });

  afterEach(() => {
    tracker?.dispose();
  });

  function startTracker(): MessageTrailTracker {
    tracker = new MessageTrailTracker({
      sessionManager: manager,
      resolveSessionFacts,
      readTrail: readTrailCalls,
      minIntervalMs: MIN_INTERVAL_MS,
      fallbackMinIntervalMs: MIN_INTERVAL_MS,
    });
    return tracker;
  }

  /** The facts the nth read (from 0) handed the reader. */
  function factsOfRead(index: number): MessageTrailReadFacts {
    return readTrailCalls.mock.calls[index][0];
  }

  it('passes the path a first lookup already carries', async () => {
    resolveSessionFacts.mockReturnValue({ ...WITHOUT_PATH, transcriptPath: REPORTED_PATH });
    startTracker().schedule('s1');

    await waitUntil(() => readTrailCalls.mock.calls.length >= 1);

    expect(factsOfRead(0).transcriptPath).toBe(REPORTED_PATH);
  });

  it('adopts the path a later lookup returns for the same conversation, on the next read', async () => {
    // The id is known at spawn; the row's reported path lands on the first status tick.
    resolveSessionFacts
      .mockReturnValueOnce(WITHOUT_PATH)
      .mockReturnValue({ ...WITHOUT_PATH, transcriptPath: REPORTED_PATH });
    startTracker().schedule('s1');

    await waitUntil(() => readTrailCalls.mock.calls.length >= 2);

    expect(factsOfRead(0).transcriptPath).toBeUndefined();
    expect(factsOfRead(1).agentSessionId).toBe('agent-1');
    expect(factsOfRead(1).transcriptPath).toBe(REPORTED_PATH);
  });

  it('stops asking the row once it has the path', async () => {
    resolveSessionFacts
      .mockReturnValueOnce(WITHOUT_PATH)
      .mockReturnValue({ ...WITHOUT_PATH, transcriptPath: REPORTED_PATH });
    const started = startTracker();
    started.schedule('s1');
    await waitUntil(() => readTrailCalls.mock.calls.length >= 2);
    expect(resolveSessionFacts).toHaveBeenCalledTimes(2);

    // A third read, once the floor between reads has passed.
    await settle(MIN_INTERVAL_MS * 2);
    started.schedule('s1');
    await waitUntil(() => readTrailCalls.mock.calls.length >= 3);

    expect(factsOfRead(2).transcriptPath).toBe(REPORTED_PATH);
    expect(resolveSessionFacts).toHaveBeenCalledTimes(2);
  });

  it('does not adopt a path the row reports for a different conversation', async () => {
    // The row moved on to another conversation (a fork): its path names that
    // one's file, not the file the tracker is reading.
    resolveSessionFacts
      .mockReturnValueOnce(WITHOUT_PATH)
      .mockReturnValue({ ...WITHOUT_PATH, agentSessionId: 'agent-2', transcriptPath: OTHER_REPORTED_PATH });
    startTracker().schedule('s1');

    await waitUntil(() => readTrailCalls.mock.calls.length >= 2);

    expect(factsOfRead(1).agentSessionId).toBe('agent-1');
    expect(factsOfRead(1).transcriptPath).toBeUndefined();
  });

  it('keeps reading without a path while the row has none', async () => {
    resolveSessionFacts.mockReturnValue(WITHOUT_PATH);
    startTracker().schedule('s1');

    await waitUntil(() => readTrailCalls.mock.calls.length >= 2);

    expect(factsOfRead(0).transcriptPath).toBeUndefined();
    expect(factsOfRead(1).transcriptPath).toBeUndefined();
    // Asked again on the second read, since the path is still missing.
    expect(resolveSessionFacts).toHaveBeenCalledTimes(2);
  });
});
