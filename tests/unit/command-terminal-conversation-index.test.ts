/**
 * Command Terminal conversations in the search index: the Earlier list's text
 * search (`ConversationIndexer.indexCommandTerminalConversation`,
 * `sweepCommandTerminalConversations`, and `searchCommandTerminalConversations`).
 *
 * Real pieces, as in conversation-indexer-resume.test.ts: a Claude-format JSONL
 * on disk, the real window parser, the real chunker and store on migrated
 * better-sqlite3. A Command Terminal has no `sessions` row, so nothing here
 * inserts one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { CommandTerminalHistoryRepository } from '../../src/main/db/repositories/command-terminal-history-repository';
import {
  ConversationIndexer,
  MAX_SESSIONS_PER_SWEEP,
} from '../../src/main/retrieval/conversation/conversation-indexer';
import { searchCommandTerminalConversations } from '../../src/main/retrieval/conversation/command-terminal-search';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import { openTestDatabase } from './helpers/test-database';

const PROJECT_ID = 'project-1';
const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function transcriptLines(words: string): string {
  const timestamp = new Date(Date.UTC(2026, 9, 4, 12)).toISOString();
  return `${[
    JSON.stringify({ type: 'user', uuid: 'user-1', timestamp, message: { role: 'user', content: `Please check ${words} for me` } }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp,
      message: { id: 'message-1', model: 'claude-test', content: [{ type: 'text', text: `I checked ${words} and it holds.` }] },
    }),
  ].join('\n')}\n`;
}

function transcriptFolder(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-terminal-index-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A Claude-shaped adapter over one folder of `<agentSessionId>.jsonl` files. */
function claudeAdapter(folder: string) {
  const fileOf = (agentSessionId: string): string => path.join(folder, `${agentSessionId}.jsonl`);
  return {
    displayName: 'Claude',
    locateSessionHistoryFile: async (agentSessionId: string) => (fs.existsSync(fileOf(agentSessionId)) ? fileOf(agentSessionId) : null),
    parseTranscriptWindow: async (agentSessionId: string, _cwd: string, startByte: number, maxBytes: number, carry?: Set<string>) => {
      if (!fs.existsSync(fileOf(agentSessionId))) return { entries: [], nextByteOffset: 0, totalBytes: 0, sourcePath: null };
      const window = await parseClaudeTranscriptWindow(fileOf(agentSessionId), startByte, maxBytes, carry);
      return { ...window, sourcePath: fileOf(agentSessionId) };
    },
  };
}

function harness(options: { adapter?: unknown; mayReadPlace?: () => Promise<boolean> } = {}) {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  const folder = transcriptFolder();
  const adapter = options.adapter === undefined ? claudeAdapter(folder) : options.adapter;
  const getAdapterByName = vi.fn(() => adapter as never);
  const indexer = new ConversationIndexer({
    getDb: () => database,
    getAdapter: () => { throw new Error('a Command Terminal has no session type to look up'); },
    getAdapterByName,
    mayReadPlace: options.mayReadPlace ?? (async () => true),
  });
  const repository = new CommandTerminalHistoryRepository(database);
  const addConversation = (agentSessionId: string, words: string | null, touched = true): void => {
    repository.recordConversation({ agentSessionId, agentName: 'claude', cwd: '/projects/demo', label: null, touched });
    repository.markEnded(agentSessionId);
    if (words !== null) fs.writeFileSync(path.join(folder, `${agentSessionId}.jsonl`), transcriptLines(words));
  };
  return { database, indexer, repository, folder, addConversation, getAdapterByName, store: new RetrievalStore(database) };
}

describe('ConversationIndexer.indexCommandTerminalConversation', () => {
  it('reads a conversation into its own corpus with no session or task, and search finds it by agent id', async () => {
    const { database, indexer, addConversation, getAdapterByName } = harness();
    addConversation('conversation-a', 'the frobnicator timing');

    expect(await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a')).toBe('indexed');

    expect(getAdapterByName).toHaveBeenCalledWith('claude');
    const chunks = database.prepare("SELECT session_id AS sessionId, task_id AS taskId, agent_session_id AS agentSessionId FROM memory_chunks WHERE corpus = 'command_terminal'").all();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => {
      const row = chunk as { sessionId: string | null; taskId: string | null; agentSessionId: string };
      return row.sessionId === null && row.taskId === null && row.agentSessionId === 'conversation-a';
    })).toBe(true);

    const [hit] = searchCommandTerminalConversations(database, 'frobnicator');
    expect(hit.agentSessionId).toBe('conversation-a');
    expect(hit.snippet.slice(hit.matchStart, hit.matchEnd).toLowerCase()).toBe('frobnicator');
  });

  it('writes nothing to the token ledger, which never counted Command Terminals', async () => {
    const { database, indexer, addConversation } = harness();
    addConversation('conversation-a', 'the ledger');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');
    expect(database.prepare('SELECT COUNT(*) AS total FROM conversation_turn_usage').get()).toEqual({ total: 0 });
  });

  it('skips an unchanged transcript and reads one that grew', async () => {
    const { indexer, folder, addConversation } = harness();
    addConversation('conversation-a', 'first words');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');
    expect(await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a')).toBe('skipped');

    fs.appendFileSync(path.join(folder, 'conversation-a.jsonl'), transcriptLines('second words'));
    expect(await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a')).toBe('indexed');
  });

  it('drops the document when its row is gone', async () => {
    const { database, indexer, repository, addConversation, store } = harness();
    addConversation('conversation-a', 'removed words');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');
    repository.delete('conversation-a');

    expect(await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a')).toBe('skipped');

    expect(searchCommandTerminalConversations(database, 'removed')).toEqual([]);
    expect(store.getIndexState('command_terminal', 'conversation-a')).toBeUndefined();
  });

  it('reads nothing from a row nobody used', async () => {
    const { database, indexer, repository } = harness();
    repository.recordConversation({ agentSessionId: 'unused', agentName: 'claude', cwd: '/projects/demo', label: null, touched: false });
    expect(await indexer.indexCommandTerminalConversation(PROJECT_ID, 'unused')).toBe('skipped');
    expect(database.prepare("SELECT COUNT(*) AS total FROM memory_chunks WHERE corpus = 'command_terminal'").get()).toEqual({ total: 0 });
  });

  it('records an agent with no transcript parser as unsupported', async () => {
    const { indexer, addConversation, store } = harness({ adapter: { displayName: 'No parser' } });
    addConversation('conversation-a', null);
    expect(await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a')).toBe('unsupported');
    expect(store.getIndexState('command_terminal', 'conversation-a')?.status).toBe('unsupported');
  });

  it('leaves a row unread while reading it would start a stopped WSL distro', async () => {
    const { indexer, addConversation, store } = harness({ mayReadPlace: async () => false });
    addConversation('conversation-a', 'words');
    expect(await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a')).toBe('skipped');
    expect(store.getIndexState('command_terminal', 'conversation-a')).toBeUndefined();
  });

  it('keeps the text of a conversation whose transcript went, until its row goes', async () => {
    const { database, indexer, folder, addConversation } = harness();
    addConversation('conversation-a', 'purged words');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');
    fs.rmSync(path.join(folder, 'conversation-a.jsonl'), { force: true });

    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');

    expect(searchCommandTerminalConversations(database, 'purged')).toHaveLength(1);
  });

  it('leaves this text out of the session purge, since a null session names no deleted session', async () => {
    const { indexer, addConversation, store } = harness();
    addConversation('conversation-a', 'kept words');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');
    expect(store.deletedSessionDocuments(10)).toEqual([]);
    expect(store.deletedSessionChunkDocuments(10)).toEqual([]);
  });

  it('gives the embedding drain nothing from this corpus', async () => {
    const { indexer, addConversation, store } = harness();
    addConversation('conversation-a', 'never embedded');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');
    expect(store.chunksNeedingEmbedding('bge@2', 50)).toEqual([]);
  });
});

describe('ConversationIndexer.sweepCommandTerminalConversations', () => {
  it('reads the rows the index has not seen, newest first, up to the per-open cap', async () => {
    const { database, indexer, addConversation } = harness();
    for (let index = 0; index < MAX_SESSIONS_PER_SWEEP + 3; index += 1) addConversation(`conversation-${index}`, `sweep word${index}`);

    await indexer.sweepCommandTerminalConversations(PROJECT_ID, () => true);

    const documents = (): number => (database.prepare("SELECT COUNT(DISTINCT doc_id) AS total FROM memory_chunks WHERE corpus = 'command_terminal'").get() as { total: number }).total;
    expect(documents()).toBe(MAX_SESSIONS_PER_SWEEP);

    await indexer.sweepCommandTerminalConversations(PROJECT_ID, () => true);
    expect(documents()).toBe(MAX_SESSIONS_PER_SWEEP + 3);
  });

  it('drops a document whose row went while indexing could not reach it, chunks with no state included', async () => {
    const { database, indexer, repository, addConversation, store } = harness();
    addConversation('conversation-a', 'orphan words');
    addConversation('conversation-b', 'kept words');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-b');
    repository.delete('conversation-a');
    database.prepare("DELETE FROM memory_index_state WHERE corpus = 'command_terminal' AND doc_id = 'conversation-a'").run();

    expect(store.orphanedCommandTerminalDocuments(10)).toEqual(['conversation-a']);
    await indexer.sweepCommandTerminalConversations(PROJECT_ID, () => true);

    expect(searchCommandTerminalConversations(database, 'orphan')).toEqual([]);
    expect(searchCommandTerminalConversations(database, 'kept')).toHaveLength(1);
  });

  it('never throws into index.sweep, so the sweeps after it still run', async () => {
    const { database, indexer, addConversation } = harness();
    addConversation('conversation-a', 'words');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    database.exec('DROP TABLE command_terminal_history');

    await expect(indexer.sweepCommandTerminalConversations(PROJECT_ID, () => true)).resolves.toBeUndefined();
    await expect(indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a')).resolves.toBe('error');
  });

  it('stops between rows when told to', async () => {
    const { database, indexer, addConversation } = harness();
    addConversation('conversation-a', 'words');
    await indexer.sweepCommandTerminalConversations(PROJECT_ID, () => false);
    expect(database.prepare("SELECT COUNT(*) AS total FROM memory_chunks WHERE corpus = 'command_terminal'").get()).toEqual({ total: 0 });
  });
});

describe('searchCommandTerminalConversations', () => {
  it('finds only its own corpus, so a task conversation with the word stays out', async () => {
    const { database, indexer, addConversation, store } = harness();
    addConversation('conversation-a', 'shared term');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');
    store.upsertDocument(
      { corpus: 'conversation', docId: 'task-conversation', sessionId: null, taskId: null, agentSessionId: 'task-conversation', metaJson: null },
      [{ seq: 0, role: 'user', text: 'shared term', contentHash: 'hash-1', tokenEstimate: 2, tsStart: null, tsEnd: null, turnUuidStart: null, turnUuidEnd: null }],
    );

    const hits = searchCommandTerminalConversations(database, 'shared');

    expect(hits.map((hit) => hit.agentSessionId)).toEqual(['conversation-a']);
  });

  it('gives one hit per conversation and matches a word as it is typed', async () => {
    const { database, indexer, addConversation } = harness();
    addConversation('conversation-a', 'release release release');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');
    expect(searchCommandTerminalConversations(database, 'relea')).toHaveLength(1);
  });

  it('hands a snippet back on one line, its range still on the match', async () => {
    const { database, indexer, addConversation } = harness();
    addConversation('conversation-a', 'marmaladeorbit');
    await indexer.indexCommandTerminalConversation(PROJECT_ID, 'conversation-a');

    const [hit] = searchCommandTerminalConversations(database, 'checked');

    expect(hit.snippet).not.toMatch(/\n/);
    expect(hit.snippet.slice(hit.matchStart, hit.matchEnd).toLowerCase()).toBe('checked');
  });

  it('answers nothing for a query with no words and never throws on FTS syntax', () => {
    const { database } = harness();
    expect(searchCommandTerminalConversations(database, '   ')).toEqual([]);
    expect(searchCommandTerminalConversations(database, '"NEAR(a b) -c:')).toEqual([]);
  });
});
