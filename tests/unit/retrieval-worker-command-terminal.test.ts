/**
 * The retrieval worker's Command Terminal wiring, positive paths:
 * `index.commandTerminalConversation`, the `commandTerminals` step of
 * `index.sweep`, and `search.commandTerminalConversations`.
 *
 * The handlers run in process. The conversation indexer is a spy (its own
 * behavior is covered by command-terminal-conversation-index.test.ts), so what
 * is pinned here is that each handler reaches the right indexer method with the
 * right arguments. The search runs against a real migrated database.
 * Tier: Unit.
 *
 * Red-green: drop the `steps.commandTerminals` line from `index.sweep` and the
 * sweep test goes red; point `index.commandTerminalConversation` at another
 * indexer method and the single-conversation test goes red; return `[]` from
 * `search.commandTerminalConversations` and the search test goes red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { indexHandlers } from '../../src/main/retrieval/worker/index-methods';
import { retrievalHandlers, type WorkerContext } from '../../src/main/retrieval/worker/methods';
import { openTestDatabase } from './helpers/test-database';

const indexerMock = vi.hoisted(() => ({
  indexCommandTerminalConversation: vi.fn(async () => 'indexed'),
  sweepCommandTerminalConversations: vi.fn(async () => undefined),
  sweepProject: vi.fn(async () => undefined),
  purgeDeletedSessions: vi.fn(async () => 0),
}));
vi.mock('../../src/main/retrieval/conversation/conversation-indexer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/retrieval/conversation/conversation-indexer')>()),
  ConversationIndexer: class {
    indexCommandTerminalConversation = indexerMock.indexCommandTerminalConversation;
    sweepCommandTerminalConversations = indexerMock.sweepCommandTerminalConversations;
    sweepProject = indexerMock.sweepProject;
    purgeDeletedSessions = indexerMock.purgeDeletedSessions;
  },
}));

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
});

function contextOver(getDb: (projectId: string) => DatabaseType.Database): WorkerContext {
  return { getDb, closeDb: () => undefined, emit: () => undefined, vecLoadError: () => null } as unknown as WorkerContext;
}

describe('index.commandTerminalConversation', () => {
  it('reads the named conversation through the indexer and reports its outcome', async () => {
    const context = contextOver(() => { throw new Error('the indexer is a spy; no database is opened'); });

    const result = await indexHandlers['index.commandTerminalConversation'](
      { projectId: 'project-1', agentSessionId: 'conversation-a', remoteTargets: [] },
      context,
    );

    expect(result).toEqual({ outcome: 'indexed' });
    expect(indexerMock.indexCommandTerminalConversation).toHaveBeenCalledWith('project-1', 'conversation-a');
  });
});

describe('index.sweep: the commandTerminals step', () => {
  const context = contextOver(() => { throw new Error('the indexer is a spy; no database is opened'); });

  it('sweeps Command Terminal conversations for the project when asked', async () => {
    const result = await indexHandlers['index.sweep']({ projectId: 'project-1', remoteTargets: [], commandTerminals: true }, context);

    expect(indexerMock.sweepCommandTerminalConversations).toHaveBeenCalledTimes(1);
    expect(indexerMock.sweepCommandTerminalConversations).toHaveBeenCalledWith('project-1', expect.any(Function));
    // It is its own step: the task conversation sweep does not ride along.
    expect(indexerMock.sweepProject).not.toHaveBeenCalled();
    expect(result).toEqual({ purged: 0, tasks: null, changes: null, commits: null, code: null });
  });

  it('leaves them alone when the step is not asked for', async () => {
    await indexHandlers['index.sweep']({ projectId: 'project-1', remoteTargets: [], conversations: true }, context);

    expect(indexerMock.sweepProject).toHaveBeenCalledTimes(1);
    expect(indexerMock.sweepCommandTerminalConversations).not.toHaveBeenCalled();
  });

  it('runs after the conversation sweep, in the same job', async () => {
    const order: string[] = [];
    indexerMock.sweepProject.mockImplementationOnce(async () => { order.push('conversations'); });
    indexerMock.sweepCommandTerminalConversations.mockImplementationOnce(async () => { order.push('commandTerminals'); });

    await indexHandlers['index.sweep']({ projectId: 'project-1', remoteTargets: [], conversations: true, commandTerminals: true }, context);

    expect(order).toEqual(['conversations', 'commandTerminals']);
  });
});

describe('search.commandTerminalConversations', () => {
  it('answers the matching conversations from the project database', () => {
    const database = openTestDatabase();
    openDatabases.push(database);
    runProjectMigrations(database);
    new RetrievalStore(database).upsertDocument(
      { corpus: 'command_terminal', docId: 'conversation-a', sessionId: null, taskId: null, agentSessionId: 'conversation-a', metaJson: null },
      [{ seq: 0, role: 'user', text: 'the rail fix landed', contentHash: 'hash-1', tokenEstimate: 5, tsStart: null, tsEnd: null, turnUuidStart: null, turnUuidEnd: null }],
    );
    const requested: string[] = [];
    const context = contextOver((projectId) => { requested.push(projectId); return database; });

    const hits = retrievalHandlers['search.commandTerminalConversations']({ projectId: 'project-1', query: 'rail' }, context);

    expect(requested).toEqual(['project-1']);
    expect(hits).toHaveLength(1);
    const [hit] = hits as Array<{ agentSessionId: string; snippet: string; matchStart: number; matchEnd: number }>;
    expect(hit.agentSessionId).toBe('conversation-a');
    expect(hit.snippet.slice(hit.matchStart, hit.matchEnd).toLowerCase()).toBe('rail');
  });

  it('answers none for a project that will not open', () => {
    const context = contextOver(() => { throw new Error('closed for deletion'); });

    expect(retrievalHandlers['search.commandTerminalConversations']({ projectId: 'project-1', query: 'rail' }, context)).toEqual([]);
  });
});
