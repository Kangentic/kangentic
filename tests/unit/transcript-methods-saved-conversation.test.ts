/**
 * The retrieval worker's reads of a conversation whose agent file is gone
 * (`worker/transcript-methods.ts`).
 *
 * `transcript.structured` builds a saved-conversation reader only when main
 * sends a `projectId`, through `readSavedConversationOf`, which answers null
 * when the project's database cannot be opened (a project closed for deletion).
 * `transcript.recapTail` formats the newest turns of the saved conversation, to
 * at most `maxChars`, and answers null (never throws) when nothing holds it.
 * `handleGetTranscript` is what sends the `projectId`, so it is driven here
 * through the worker's real handlers.
 *
 * Real pieces: Claude-format JSONL, the real window parser, Brotli, a migrated
 * better-sqlite3 database, the worker's `retrievalHandlers`. The registry is
 * mocked so the agent's live parse finds nothing, as it does once the agent
 * deletes its file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';

const hoisted = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(), list: vi.fn(() => []), get: vi.fn() },
}));

// `handleGetTranscript` reaches the worker through this client; the test routes
// its calls to the worker's own handlers in this process.
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: class RetrievalUnavailableError extends Error {},
  retrievalClient: { call: hoisted.call },
}));

// A workflow's agent resolves through its workflow row; none is used here.
vi.mock('../../src/main/workflows/workflow-service', () => ({
  resolveWorkflow: vi.fn(),
  WorkflowRequestError: class WorkflowRequestError extends Error {},
}));

import { agentRegistry } from '../../src/main/agent/agent-registry';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { transcriptHandlers } from '../../src/main/retrieval/worker/transcript-methods';
import { retrievalHandlers, type WorkerContext } from '../../src/main/retrieval/worker/methods';
import { handleGetTranscript } from '../../src/main/agent/commands/inspect-commands';
import {
  TranscriptArchive,
  resetArchiveReadCacheForTests,
  type ArchiveAdapter,
} from '../../src/main/retrieval/archive/transcript-archive';
import {
  resetForTests as resetTranscriptServiceForTests,
  setIndexedChunkReaderForTests,
  type IndexedChunk,
} from '../../src/main/agent/transcript-service';
import { parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import { openTestDatabase } from './helpers/test-database';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { StructuredTranscriptRequest } from '../../src/main/agent/commands/structured-transcript';
import type { CommandContext } from '../../src/main/agent/commands/types';

const WINDOW_BYTES = 2000;
const TURNS = 12;
const OPEN_PROJECT = 'project-open';
const GONE_PROJECT = 'project-closed-for-deletion';
const ARCHIVE_HEADER = 'Source: Kangentic\'s saved copy (the agent deleted its own file)';
const INDEX_HEADER = 'Source: indexed text only (the agent deleted its own file; tool calls are flattened)';
const NOT_FOUND = 'No structured transcript found';
const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

const readIndexedChunks = vi.fn<(db: DatabaseType.Database, docId: string) => Promise<IndexedChunk[]>>();

beforeEach(() => {
  resetArchiveReadCacheForTests();
  resetTranscriptServiceForTests();
  hoisted.call.mockReset();
  readIndexedChunks.mockReset();
  readIndexedChunks.mockResolvedValue([]);
  setIndexedChunkReaderForTests(readIndexedChunks);
  // The agent's live parse finds nothing: its file is gone.
  vi.mocked(agentRegistry.getBySessionType).mockReset();
  vi.mocked(agentRegistry.getBySessionType).mockReturnValue({
    displayName: 'Archived Agent',
    parseTranscript: vi.fn(async () => ({ entries: [], sourcePath: null })),
  } as unknown as AgentAdapter);
});

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function transcriptLines(turns: number): string[] {
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const timestamp = new Date(Date.UTC(2026, 8, 30, 12, 0, turn)).toISOString();
    lines.push(JSON.stringify({
      type: 'user', uuid: `user-${turn}`, timestamp,
      message: { role: 'user', content: `archived question ${turn}` },
    }));
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `assistant-${turn}`, timestamp,
      message: {
        id: `message-${turn}`, model: 'claude-test',
        content: [{ type: 'text', text: `archived answer ${turn}` }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
      },
    }));
  }
  return lines;
}

interface Fixture {
  database: DatabaseType.Database;
  /** Opens `OPEN_PROJECT`'s database; throws for `GONE_PROJECT`, as a closed-for-deletion project does. */
  context: WorkerContext;
  getDb: ReturnType<typeof vi.fn>;
  agentSessionId: string;
}

/** A migrated database whose one session ran a conversation the archive holds. */
async function archivedFixture(): Promise<Fixture> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-methods-saved-'));
  temporaryDirectories.push(directory);
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  const agentSessionId = 'agent-archived';
  database.prepare(
    `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
     VALUES ('session-archived', 'task-1', 'archived_agent', ?, 'agent', '/work', 'suspended', '2026-09-30T12:00:00.000Z')`,
  ).run(agentSessionId);

  const sourcePath = path.join(directory, `${agentSessionId}.jsonl`);
  fs.writeFileSync(sourcePath, `${transcriptLines(TURNS).join('\n')}\n`);
  const archiveAdapter: ArchiveAdapter = {
    locateSessionHistoryFile: async () => sourcePath,
    parseTranscriptWindow: async (_id, _cwd, startByte, maxBytes, carry) => {
      const window = await parseClaudeTranscriptWindow(sourcePath, startByte, maxBytes, carry);
      return { ...window, sourcePath };
    },
  };
  const archive = new TranscriptArchive({ getDb: () => database, getAdapter: () => archiveAdapter, windowBytes: WINDOW_BYTES });
  expect(await archive.archiveSession(OPEN_PROJECT, 'session-archived')).toBe('archived');
  // The agent then deletes its own file.
  fs.rmSync(sourcePath);

  const getDb = vi.fn((projectId: string) => {
    if (projectId === GONE_PROJECT) throw new Error('the project database is closed for deletion');
    return database;
  });
  const context: WorkerContext = { getDb, closeDb: () => undefined, vecLoadError: () => null, emit: () => undefined };
  return { database, context, getDb, agentSessionId };
}

function structuredRequest(agentSessionId: string): StructuredTranscriptRequest {
  return {
    record: { id: 'session-archived', sessionType: 'archived_agent', agentSessionId, cwd: '/work' },
    view: 'full',
    tail: undefined,
    charBudget: 40_000,
    search: undefined,
    aroundUuid: undefined,
    contextTurns: 3,
  };
}

describe('transcript.structured', () => {
  it('reads an archived conversation through the project it was sent, and says so', async () => {
    const { context, getDb, agentSessionId } = await archivedFixture();

    const response = await transcriptHandlers['transcript.structured'](
      { request: structuredRequest(agentSessionId), projectId: OPEN_PROJECT, remoteTargets: [] },
      context,
    );

    expect(getDb).toHaveBeenCalledWith(OPEN_PROJECT);
    expect(response.success).toBe(true);
    expect(response.message).toContain(ARCHIVE_HEADER);
    expect(response.message).toContain('archived question 0');
    expect(response.message).toContain(`archived answer ${TURNS - 1}`);
    expect(response.message).not.toContain(NOT_FOUND);
  });

  it('says only indexed text was kept when the index, not the archive, holds the conversation', async () => {
    const { context } = await archivedFixture();
    readIndexedChunks.mockImplementation(async (_db, docId) => (docId === 'agent-indexed-only'
      ? [{ id: 9, role: 'user', text: 'a question only the index kept', tsStart: 5, turnUuidStart: 'indexed-1' }]
      : []));

    const response = await transcriptHandlers['transcript.structured'](
      { request: structuredRequest('agent-indexed-only'), projectId: OPEN_PROJECT, remoteTargets: [] },
      context,
    );

    expect(response.message).toContain(INDEX_HEADER);
    expect(response.message).not.toContain(ARCHIVE_HEADER);
    expect(response.message).toContain('a question only the index kept');
  });

  it('builds no reader without a projectId: it never opens a database and answers "not found"', async () => {
    const { context, getDb, agentSessionId } = await archivedFixture();

    const response = await transcriptHandlers['transcript.structured'](
      { request: structuredRequest(agentSessionId), remoteTargets: [] },
      context,
    );

    expect(getDb).not.toHaveBeenCalled();
    expect(response.message).toContain(NOT_FOUND);
    expect(response.message).not.toContain('archived question 0');
  });

  it('answers "not found", not an error, when the project\'s database cannot be opened', async () => {
    const { context, getDb, agentSessionId } = await archivedFixture();

    await expect(transcriptHandlers['transcript.structured'](
      { request: structuredRequest(agentSessionId), projectId: GONE_PROJECT, remoteTargets: [] },
      context,
    )).resolves.toMatchObject({ success: true, message: expect.stringContaining(NOT_FOUND) });
    // The reader was built and asked, so the throwing branch is the one that answered.
    expect(getDb).toHaveBeenCalledWith(GONE_PROJECT);
  });

  it('answers "not found" for a conversation nothing holds in a project that opens', async () => {
    const { context, getDb } = await archivedFixture();

    const response = await transcriptHandlers['transcript.structured'](
      { request: structuredRequest('agent-unknown'), projectId: OPEN_PROJECT, remoteTargets: [] },
      context,
    );

    expect(getDb).toHaveBeenCalledWith(OPEN_PROJECT);
    expect(response.message).toContain(NOT_FOUND);
  });
});

describe('transcript.recapTail', () => {
  it('returns the newest turns of an archived conversation within maxChars', async () => {
    const { context, agentSessionId } = await archivedFixture();
    const maxChars = 150;

    const tail = await transcriptHandlers['transcript.recapTail']({ projectId: OPEN_PROJECT, agentSessionId, maxChars }, context);

    expect(tail).not.toBeNull();
    expect(tail!.length).toBeLessThanOrEqual(maxChars);
    expect(tail).toContain(`archived answer ${TURNS - 1}`);
    expect(tail).not.toContain('archived question 0');
  });

  it('returns every turn when maxChars leaves room for them, so the bound is the caller\'s', async () => {
    const { context, agentSessionId } = await archivedFixture();

    const tail = await transcriptHandlers['transcript.recapTail']({ projectId: OPEN_PROJECT, agentSessionId, maxChars: 100_000 }, context);

    expect(tail).toContain('archived question 0');
    expect(tail).toContain(`archived answer ${TURNS - 1}`);
  });

  it('returns null for a conversation nothing holds', async () => {
    const { context, getDb } = await archivedFixture();

    const tail = await transcriptHandlers['transcript.recapTail']({ projectId: OPEN_PROJECT, agentSessionId: 'agent-unknown', maxChars: 500 }, context);

    expect(getDb).toHaveBeenCalledWith(OPEN_PROJECT);
    expect(tail).toBeNull();
  });

  it('returns null, and does not throw, when the project\'s database cannot be opened', async () => {
    const { context, getDb, agentSessionId } = await archivedFixture();

    await expect(transcriptHandlers['transcript.recapTail'](
      { projectId: GONE_PROJECT, agentSessionId, maxChars: 500 },
      context,
    )).resolves.toBeNull();
    expect(getDb).toHaveBeenCalledWith(GONE_PROJECT);
  });
});

describe('handleGetTranscript', () => {
  /** A command context bound to one project, over the fixture's database. */
  function commandContext(database: DatabaseType.Database, projectId: string): CommandContext {
    return { projectId, getProjectDb: () => database, getProjectPath: () => os.tmpdir() } as unknown as CommandContext;
  }

  it('sends the context\'s projectId, so a deleted conversation reads from that project\'s archive', async () => {
    const { database, context } = await archivedFixture();
    hoisted.call.mockImplementation(async (method: keyof typeof retrievalHandlers, params: unknown) => (
      (retrievalHandlers[method] as (params: unknown, workerContext: WorkerContext) => unknown)(params, context)
    ));

    const response = await handleGetTranscript({ sessionId: 'session-archived' }, commandContext(database, OPEN_PROJECT));

    expect(hoisted.call).toHaveBeenCalledWith('transcript.structured', expect.objectContaining({ projectId: OPEN_PROJECT }));
    expect(response.success).toBe(true);
    expect(response.message).toContain(ARCHIVE_HEADER);
    expect(response.message).toContain(`archived answer ${TURNS - 1}`);
  });

  it('sends whichever project the request is scoped to, not a fixed one', async () => {
    const { database, context } = await archivedFixture();
    hoisted.call.mockImplementation(async (method: keyof typeof retrievalHandlers, params: unknown) => (
      (retrievalHandlers[method] as (params: unknown, workerContext: WorkerContext) => unknown)(params, context)
    ));

    // The same session record, read for a project whose worker database is gone.
    const response = await handleGetTranscript({ sessionId: 'session-archived' }, commandContext(database, GONE_PROJECT));

    expect(hoisted.call).toHaveBeenCalledWith('transcript.structured', expect.objectContaining({ projectId: GONE_PROJECT }));
    expect(response.success).toBe(true);
    expect(response.message).toContain(NOT_FOUND);
    expect(response.message).not.toContain(ARCHIVE_HEADER);
  });
});
