/**
 * A chunker change invalidates every chunk it produced, so `sweepProject`
 * purges the conversation, change and Command Terminal corpora and stamps the
 * new version. The Command Terminal corpus is the case pinned here: its chunks
 * come from the same chunker, so a stale one would stay searchable under old
 * boundaries while no sweep re-read it.
 *
 * Real pieces, as in command-terminal-conversation-index.test.ts: a Claude
 * format JSONL on disk, the real window parser, chunker and store on migrated
 * better-sqlite3. Tier: Unit.
 *
 * Red-green: drop `COMMAND_TERMINAL_CORPUS` from the `purgeCorpora` list in
 * `sweepProject` and the first test fails (the document survives the version
 * change).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { CommandTerminalHistoryRepository } from '../../src/main/db/repositories/command-terminal-history-repository';
import { ConversationIndexer } from '../../src/main/retrieval/conversation/conversation-indexer';
import { searchCommandTerminalConversations } from '../../src/main/retrieval/conversation/command-terminal-search';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import { openTestDatabase } from './helpers/test-database';

const PROJECT_ID = 'project-1';
const CONVERSATION_ID = 'conversation-a';
const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
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

/** An indexer over a migrated database holding one indexed Command Terminal conversation. */
async function indexedConversation(chunkerVersion: number) {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-chunker-purge-'));
  temporaryDirectories.push(folder);
  const transcriptPath = path.join(folder, `${CONVERSATION_ID}.jsonl`);
  fs.writeFileSync(transcriptPath, transcriptLines('the frobnicator timing'));
  const adapter = {
    displayName: 'Claude',
    locateSessionHistoryFile: async () => transcriptPath,
    parseTranscriptWindow: async (_agentSessionId: string, _cwd: string, startByte: number, maxBytes: number, carry?: Set<string>) => ({
      ...(await parseClaudeTranscriptWindow(transcriptPath, startByte, maxBytes, carry)),
      sourcePath: transcriptPath,
    }),
  };
  const buildIndexer = (version: number) => new ConversationIndexer({
    getDb: () => database,
    getAdapter: () => { throw new Error('a Command Terminal has no session type to look up'); },
    getAdapterByName: () => adapter as never,
    mayReadPlace: async () => true,
    chunkerVersion: version,
  });
  const repository = new CommandTerminalHistoryRepository(database);
  repository.recordConversation({ agentSessionId: CONVERSATION_ID, agentName: 'claude', cwd: '/projects/demo', label: null, touched: true });
  repository.markEnded(CONVERSATION_ID);

  const indexer = buildIndexer(chunkerVersion);
  // A database with no stamp counts as a version change, so the first sweep
  // stamps the version before anything is indexed under it.
  await indexer.sweepProject(PROJECT_ID, () => true);
  expect(await indexer.indexCommandTerminalConversation(PROJECT_ID, CONVERSATION_ID)).toBe('indexed');
  return { database, buildIndexer, store: new RetrievalStore(database) };
}

describe('ConversationIndexer.sweepProject: a chunker version change', () => {
  it('purges the Command Terminal corpus along with the others, and stamps the new version', async () => {
    const { database, buildIndexer, store } = await indexedConversation(1);
    // Control: the document is searchable and the old version is stamped.
    expect(searchCommandTerminalConversations(database, 'frobnicator')).toHaveLength(1);
    expect(store.getMeta('chunker_version')).toBe('1');

    await buildIndexer(2).sweepProject(PROJECT_ID, () => true);

    expect(searchCommandTerminalConversations(database, 'frobnicator')).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) AS total FROM memory_chunks WHERE corpus = 'command_terminal'").get()).toEqual({ total: 0 });
    expect(store.getIndexState('command_terminal', CONVERSATION_ID)).toBeUndefined();
    expect(store.getMeta('chunker_version')).toBe('2');
  });

  it('leaves the Command Terminal corpus alone while the version is unchanged', async () => {
    const { database, buildIndexer, store } = await indexedConversation(1);

    await buildIndexer(1).sweepProject(PROJECT_ID, () => true);

    expect(searchCommandTerminalConversations(database, 'frobnicator')).toHaveLength(1);
    expect(store.getIndexState('command_terminal', CONVERSATION_ID)).toBeDefined();
    expect(store.getMeta('chunker_version')).toBe('1');
  });
});
