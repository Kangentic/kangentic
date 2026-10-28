/**
 * The conversation indexer hands the agent-reported transcript path to the
 * adapter (`src/main/retrieval/conversation/conversation-indexer.ts`).
 *
 * A session row's `transcript_path` names the file the agent reported writing
 * the conversation to, which can be outside the folder the cwd maps to. Every
 * adapter capability the indexer calls takes it as a trailing `reportedPath`:
 * `locateSessionHistoryFile` (the staleness signature), `parseTranscriptWindow`
 * (the windowed walk) or `parseTranscript` (the whole-file fallback), and for the
 * subagent pass `statSubagentTranscripts` and `parseSubagentUsage`. An indexer that
 * drops it on any of them indexes the wrong file or none. The existing indexer
 * tests give their adapters no use for the argument, so a dropped one goes unnoticed.
 *
 * A workflow's own agent has no session row, so `recordWorkflowAgentTurns` takes
 * the path from its `owner`, and the worker method `index.workflowAgentTurns`
 * has to forward the `transcriptPath` main sends it.
 *
 * Real migrated better-sqlite3 and the real indexer. The adapters are recording
 * stubs; the agent registry is mocked so the worker method resolves them.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(), list: vi.fn(() => []), get: vi.fn() },
}));

import { agentRegistry } from '../../src/main/agent/agent-registry';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { ConversationIndexer, type ConversationIndexerDeps } from '../../src/main/retrieval/conversation/conversation-indexer';
import { indexHandlers } from '../../src/main/retrieval/worker/index-methods';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';
import type { AgentAdapter, ParsedSubagentUsage, ParsedTranscript, ParsedTranscriptWindow } from '../../src/main/agent/agent-adapter';
import { openTestDatabase } from './helpers/test-database';
import type { TranscriptEntry } from '../../src/shared/types';

type IndexerAdapter = NonNullable<ReturnType<ConversationIndexerDeps['getAdapter']>>;
type LocateArguments = Parameters<NonNullable<IndexerAdapter['locateSessionHistoryFile']>>;
type WindowArguments = Parameters<NonNullable<IndexerAdapter['parseTranscriptWindow']>>;
type WholeFileArguments = Parameters<NonNullable<IndexerAdapter['parseTranscript']>>;
type StatSubagentArguments = Parameters<NonNullable<IndexerAdapter['statSubagentTranscripts']>>;
type ParseSubagentArguments = Parameters<NonNullable<IndexerAdapter['parseSubagentUsage']>>;

/** Where `reportedPath` sits in each recorded call. */
const REPORTED_PATH_INDEX = { locate: 3, window: 6, wholeFile: 3, statSubagent: 3, parseSubagent: 3 } as const;

const SOURCE_PATH = path.join(os.tmpdir(), 'kangentic-reported-path-indexer', 'agent-1.jsonl');
const REPORTED_PATH = path.join(os.tmpdir(), 'kangentic-reported-path-indexer', 'reported', 'agent-1.jsonl');
const AGENT_SESSION_ID = 'agent-1';
const WORKER_PROJECT_ID = 'project-1';

const openDatabases: DatabaseType.Database[] = [];

beforeEach(() => {
  vi.mocked(agentRegistry.list).mockReturnValue([]);
  vi.mocked(agentRegistry.getBySessionType).mockReset();
});

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const USER_ENTRY: TranscriptEntry = { kind: 'user', uuid: 'user-1', ts: 1, text: 'Which file holds the conversation?' };

interface RecordedCalls {
  locate: LocateArguments[];
  window: WindowArguments[];
  wholeFile: WholeFileArguments[];
  statSubagent: StatSubagentArguments[];
  parseSubagent: ParseSubagentArguments[];
}

interface Capabilities {
  /** `parseTranscriptWindow`: the windowed walk the indexer prefers. */
  windowed?: boolean;
  /** `parseTranscript`: the whole-file parse an adapter without windows falls back to. */
  wholeFile?: boolean;
  /** `statSubagentTranscripts` and `parseSubagentUsage`. */
  subagents?: boolean;
}

/** An adapter with the capabilities asked for, each recording every argument it was called with. */
function recordingAdapter(capabilities: Capabilities): { adapter: IndexerAdapter; calls: RecordedCalls } {
  const calls: RecordedCalls = { locate: [], window: [], wholeFile: [], statSubagent: [], parseSubagent: [] };
  const windowed = capabilities.windowed
    ? {
        parseTranscriptWindow: async (...args: WindowArguments): Promise<ParsedTranscriptWindow> => {
          calls.window.push(args);
          return { entries: [USER_ENTRY], sourcePath: SOURCE_PATH, nextByteOffset: 100, totalBytes: 100, firstByteOffset: 0, endByte: 100 };
        },
      }
    : {};
  const wholeFile = capabilities.wholeFile
    ? {
        parseTranscript: async (...args: WholeFileArguments): Promise<ParsedTranscript> => {
          calls.wholeFile.push(args);
          return { entries: [USER_ENTRY], sourcePath: SOURCE_PATH };
        },
      }
    : {};
  const subagents = capabilities.subagents
    ? {
        statSubagentTranscripts: (...args: StatSubagentArguments) => {
          calls.statSubagent.push(args);
          return { fileCount: 1, totalSize: 10, maxMtimeMs: 1 };
        },
        parseSubagentUsage: async (...args: ParseSubagentArguments): Promise<ParsedSubagentUsage> => {
          calls.parseSubagent.push(args);
          return { directoryPresent: true, complete: true, sourcePath: SOURCE_PATH, turns: [], spawnLinks: [] };
        },
      }
    : {};
  const adapter: IndexerAdapter = {
    displayName: 'Recording',
    locateSessionHistoryFile: async (...args: LocateArguments) => {
      calls.locate.push(args);
      return SOURCE_PATH;
    },
    ...windowed,
    ...wholeFile,
    ...subagents,
  };
  return { adapter, calls };
}

/** The distinct values the calls carried at `index`: empty when nothing was called. */
function distinctAt(calls: ReadonlyArray<ReadonlyArray<unknown>>, index: number): unknown[] {
  return [...new Set(calls.map((args) => args[index]))];
}

interface Harness {
  database: DatabaseType.Database;
  indexer: ConversationIndexer;
}

/** A migrated project with one session row (`transcriptPath` as its status line reported it) and an indexer over `adapter`. */
function harness(adapter: IndexerAdapter, transcriptPath: string | null = null): Harness {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  database.prepare(
    `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at, transcript_path)
     VALUES ('session-1', 'task-1', 'claude_agent', ?, 'claude', '/work', 'suspended', '2026-10-04T12:00:00.000Z', ?)`,
  ).run(AGENT_SESSION_ID, transcriptPath);
  const indexer = new ConversationIndexer({
    getDb: () => database,
    getAdapter: () => adapter,
    stat: () => ({ mtimeMs: 1, size: 100 }),
    hashBefore: async () => null,
    mayReadPlace: async () => true,
    windowBytes: 2000,
  });
  return { database, indexer };
}

describe('ConversationIndexer.indexSession hands the reported path to the adapter', () => {
  it('passes the row\'s path to the signature locate and to every window of the walk', async () => {
    const { adapter, calls } = recordingAdapter({ windowed: true });
    const { indexer } = harness(adapter, REPORTED_PATH);

    expect(await indexer.indexSession('project-1', 'session-1')).toBe('indexed');

    expect(distinctAt(calls.locate, REPORTED_PATH_INDEX.locate)).toEqual([REPORTED_PATH]);
    expect(distinctAt(calls.window, REPORTED_PATH_INDEX.window)).toEqual([REPORTED_PATH]);
  });

  it('passes the row\'s path to the whole-file parse of an adapter with no windowed walk', async () => {
    const { adapter, calls } = recordingAdapter({ wholeFile: true });
    const { indexer } = harness(adapter, REPORTED_PATH);

    expect(await indexer.indexSession('project-1', 'session-1')).toBe('indexed');

    expect(distinctAt(calls.locate, REPORTED_PATH_INDEX.locate)).toEqual([REPORTED_PATH]);
    expect(distinctAt(calls.wholeFile, REPORTED_PATH_INDEX.wholeFile)).toEqual([REPORTED_PATH]);
    expect(calls.window).toEqual([]);
  });

  it('passes null, not a missing argument, for a row that reported no path', async () => {
    const windowed = recordingAdapter({ windowed: true });
    expect(await harness(windowed.adapter, null).indexer.indexSession('project-1', 'session-1')).toBe('indexed');
    expect(distinctAt(windowed.calls.locate, REPORTED_PATH_INDEX.locate)).toEqual([null]);
    expect(distinctAt(windowed.calls.window, REPORTED_PATH_INDEX.window)).toEqual([null]);

    const wholeFile = recordingAdapter({ wholeFile: true });
    expect(await harness(wholeFile.adapter, null).indexer.indexSession('project-1', 'session-1')).toBe('indexed');
    expect(distinctAt(wholeFile.calls.wholeFile, REPORTED_PATH_INDEX.wholeFile)).toEqual([null]);
  });
});

describe('ConversationIndexer.indexSubagentUsage hands the reported path to the adapter', () => {
  it('passes the row\'s path to the directory stat and to the usage parse', async () => {
    const { adapter, calls } = recordingAdapter({ subagents: true });
    const { indexer } = harness(adapter, REPORTED_PATH);

    expect(await indexer.indexSubagentUsage('project-1', 'session-1')).toBe('indexed');

    expect(distinctAt(calls.statSubagent, REPORTED_PATH_INDEX.statSubagent)).toEqual([REPORTED_PATH]);
    expect(distinctAt(calls.parseSubagent, REPORTED_PATH_INDEX.parseSubagent)).toEqual([REPORTED_PATH]);
  });

  it('passes null, not a missing argument, for a row that reported no path', async () => {
    const { adapter, calls } = recordingAdapter({ subagents: true });
    const { indexer } = harness(adapter, null);

    expect(await indexer.indexSubagentUsage('project-1', 'session-1')).toBe('indexed');

    expect(distinctAt(calls.statSubagent, REPORTED_PATH_INDEX.statSubagent)).toEqual([null]);
    expect(distinctAt(calls.parseSubagent, REPORTED_PATH_INDEX.parseSubagent)).toEqual([null]);
  });
});

describe('ConversationIndexer.recordWorkflowAgentTurns hands the owner\'s reported path to the walk', () => {
  const OWNER = { sessionId: 'pty-workflow-agent-1', agentSessionId: AGENT_SESSION_ID, sessionType: 'claude_agent', cwd: '/work' };

  it('passes owner.transcriptPath to every window of the walk', async () => {
    const { adapter, calls } = recordingAdapter({ windowed: true });
    const { indexer } = harness(adapter);

    expect(await indexer.recordWorkflowAgentTurns('project-1', { ...OWNER, transcriptPath: REPORTED_PATH })).toBe('indexed');

    expect(distinctAt(calls.window, REPORTED_PATH_INDEX.window)).toEqual([REPORTED_PATH]);
  });

  it('passes owner.transcriptPath to the whole-file parse of an adapter with no windowed walk', async () => {
    const { adapter, calls } = recordingAdapter({ wholeFile: true });
    const { indexer } = harness(adapter);

    expect(await indexer.recordWorkflowAgentTurns('project-1', { ...OWNER, transcriptPath: REPORTED_PATH })).toBe('indexed');

    expect(distinctAt(calls.wholeFile, REPORTED_PATH_INDEX.wholeFile)).toEqual([REPORTED_PATH]);
  });

  it('passes null when the owner has no transcript path yet, or names it null', async () => {
    const { adapter, calls } = recordingAdapter({ windowed: true });
    const { indexer } = harness(adapter);

    await indexer.recordWorkflowAgentTurns('project-1', OWNER);
    await indexer.recordWorkflowAgentTurns('project-1', { ...OWNER, transcriptPath: null });

    expect(calls.window).toHaveLength(2);
    expect(distinctAt(calls.window, REPORTED_PATH_INDEX.window)).toEqual([null]);
  });
});

describe("worker method 'index.workflowAgentTurns' forwards the transcript path main sends", () => {
  function workerContext(database: DatabaseType.Database): WorkerContext {
    return { getDb: () => database, closeDb: () => undefined, vecLoadError: () => null, emit: () => undefined };
  }

  const PARAMS = {
    projectId: WORKER_PROJECT_ID,
    sessionId: 'pty-workflow-agent-1',
    agentSessionId: AGENT_SESSION_ID,
    sessionType: 'claude_agent',
    cwd: '/work',
    remoteTargets: [],
  };

  it('reaches the adapter\'s walk as the reported path', async () => {
    const { adapter, calls } = recordingAdapter({ windowed: true });
    const { database } = harness(adapter);
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(adapter as unknown as AgentAdapter);

    const result = await indexHandlers['index.workflowAgentTurns']({ ...PARAMS, transcriptPath: REPORTED_PATH }, workerContext(database));

    expect(result).toEqual({ outcome: 'indexed' });
    expect(distinctAt(calls.window, REPORTED_PATH_INDEX.window)).toEqual([REPORTED_PATH]);
  });

  it('passes null when main sends none', async () => {
    const { adapter, calls } = recordingAdapter({ windowed: true });
    const { database } = harness(adapter);
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(adapter as unknown as AgentAdapter);

    const result = await indexHandlers['index.workflowAgentTurns'](PARAMS, workerContext(database));

    expect(result).toEqual({ outcome: 'indexed' });
    expect(distinctAt(calls.window, REPORTED_PATH_INDEX.window)).toEqual([null]);
  });
});
