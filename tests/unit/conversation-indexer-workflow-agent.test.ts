/**
 * A workflow's own agent's turns reach the token ledger, and nothing else
 * (`ConversationIndexer.recordWorkflowAgentTurns` in
 * src/main/retrieval/conversation/conversation-indexer.ts).
 *
 * The agent has no `sessions` row: it is a transient session carrying the
 * workflow's id, so the caller names its conversation and the PTY session id the
 * Stats ledger keys it by. Its turns land in `conversation_turn_usage` with that
 * session id and a NULL task id. Its planning conversation is not task work, so
 * no search document is written (no memory_chunks, no memory_index_state row).
 *
 * Real pieces, as in conversation-indexer-resume.test.ts: a Claude-format JSONL
 * on disk, the real window parser, and the real ledger on migrated better-sqlite3.
 * The workflow-agent project keeps foreign keys ON, as the app's connections do,
 * so a PTY session id that no `sessions` row carries is proven to be accepted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { ConversationIndexer } from '../../src/main/retrieval/conversation/conversation-indexer';
import { parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import { openTestDatabase } from './helpers/test-database';

const AGENT_SESSION_ID = 'workflow-conversation-1';
const OWNER = { sessionId: 'pty-workflow-agent-1', agentSessionId: AGENT_SESSION_ID, sessionType: 'claude_agent', cwd: '/work' };
const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryFile(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-workflow-turns-'));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

/** A Claude transcript: one user line and one assistant line (with usage) per turn. */
function transcriptLines(turns: number): string[] {
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const timestamp = new Date(Date.UTC(2026, 9, 4, 12, 0, turn)).toISOString();
    lines.push(JSON.stringify({
      type: 'user',
      uuid: `user-${turn}`,
      timestamp,
      message: { role: 'user', content: `Plan the workflow, step ${turn}: which tasks block the budgets API?` },
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: `assistant-${turn}`,
      timestamp,
      message: {
        id: `message-${turn}`,
        model: 'claude-test',
        content: [{ type: 'text', text: `Step ${turn}: the API task blocks the UI and the phone task.` }],
        usage: { input_tokens: 10 + turn, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 + turn },
      },
    }));
  }
  return lines;
}

function writeTranscript(filePath: string, turns: number): void {
  fs.writeFileSync(filePath, turns === 0 ? '' : `${transcriptLines(turns).join('\n')}\n`);
}

type TestDatabase = DatabaseType.Database;

interface Harness {
  database: TestDatabase;
  indexer: ConversationIndexer;
}

/** A migrated project and an indexer whose adapter is `adapter`. */
function harness(adapter: unknown, options: { foreignKeys?: boolean } = {}): Harness {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  if (options.foreignKeys === false) database.exec('PRAGMA foreign_keys = OFF');
  const indexer = new ConversationIndexer({
    getDb: () => database,
    getAdapter: () => adapter as never,
    windowBytes: 2000,
  });
  return { database, indexer };
}

function claudeAdapter(transcriptPath: string) {
  return {
    displayName: 'Claude',
    subagentSpawnToolName: 'Task',
    locateSessionHistoryFile: async () => transcriptPath,
    parseTranscriptWindow: async (_agentSessionId: string, _cwd: string, startByte: number, maxBytes: number, carry?: Set<string>) => {
      const window = await parseClaudeTranscriptWindow(transcriptPath, startByte, maxBytes, carry);
      return { ...window, sourcePath: transcriptPath };
    },
  };
}

interface LedgerRow {
  turn: string;
  agentSessionId: string | null;
  sessionId: string | null;
  taskId: string | null;
  input: number;
  output: number;
}

function ledger(database: TestDatabase): LedgerRow[] {
  return database.prepare(
    `SELECT turn_uuid AS turn, agent_session_id AS agentSessionId, session_id AS sessionId, task_id AS taskId,
            input_tokens AS input, output_tokens AS output
       FROM conversation_turn_usage ORDER BY turn_uuid`,
  ).all() as unknown as LedgerRow[];
}

function count(database: TestDatabase, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;
}

describe('ConversationIndexer.recordWorkflowAgentTurns', () => {
  it('writes each turn to the ledger under the given session id and conversation, with no task', async () => {
    const transcriptPath = temporaryFile('conversation.jsonl');
    writeTranscript(transcriptPath, 12);
    const { database, indexer } = harness(claudeAdapter(transcriptPath));

    expect(await indexer.recordWorkflowAgentTurns('project-1', OWNER)).toBe('indexed');

    const rows = ledger(database);
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => row.sessionId === OWNER.sessionId)).toBe(true);
    expect(rows.every((row) => row.agentSessionId === AGENT_SESSION_ID)).toBe(true);
    expect(rows.every((row) => row.taskId === null)).toBe(true);
    // The transcript's own numbers: input 10 + turn, output 5 per turn.
    expect(rows.reduce((total, row) => total + row.input, 0)).toBe(Array.from({ length: 12 }, (_unused, turn) => 10 + turn).reduce((sum, value) => sum + value, 0));
    expect(rows.reduce((total, row) => total + row.output, 0)).toBe(12 * 5);
  });

  it('writes no search document: no chunks and no index-state row, where a task session\'s walk of the same transcript writes both', async () => {
    const transcriptPath = temporaryFile('conversation.jsonl');
    writeTranscript(transcriptPath, 12);

    // Control: the same transcript as a TASK session's conversation does index
    // chunks, so an empty result below is not the transcript's doing.
    const control = harness(claudeAdapter(transcriptPath), { foreignKeys: false });
    control.database.prepare(
      `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
       VALUES ('session-1', 'task-1', 'claude_agent', ?, 'claude', '/work', 'running', '2026-10-04T12:00:00.000Z')`,
    ).run(AGENT_SESSION_ID);
    expect(await control.indexer.indexSession('project-1', 'session-1')).toBe('indexed');
    expect(count(control.database, 'memory_chunks')).toBeGreaterThan(0);
    expect(count(control.database, 'memory_index_state')).toBeGreaterThan(0);

    const { database, indexer } = harness(claudeAdapter(transcriptPath));
    const chunksBefore = count(database, 'memory_chunks');
    const stateBefore = count(database, 'memory_index_state');

    expect(await indexer.recordWorkflowAgentTurns('project-1', OWNER)).toBe('indexed');

    expect(count(database, 'memory_chunks')).toBe(chunksBefore);
    expect(count(database, 'memory_index_state')).toBe(stateBefore);
    expect(count(database, 'conversation_turn_usage')).toBe(12);
  });

  it('records each turn once however often it runs, and a later session re-owns them', async () => {
    const transcriptPath = temporaryFile('conversation.jsonl');
    writeTranscript(transcriptPath, 6);
    const { database, indexer } = harness(claudeAdapter(transcriptPath));

    await indexer.recordWorkflowAgentTurns('project-1', OWNER);
    await indexer.recordWorkflowAgentTurns('project-1', OWNER);
    expect(ledger(database)).toHaveLength(6);

    // The workflow's agent resumed in a new PTY: the same conversation, a new session id.
    await indexer.recordWorkflowAgentTurns('project-1', { ...OWNER, sessionId: 'pty-workflow-agent-2' });
    const rows = ledger(database);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.sessionId === 'pty-workflow-agent-2')).toBe(true);
  });

  it('picks up the turns a later stop adds to the same conversation', async () => {
    const transcriptPath = temporaryFile('conversation.jsonl');
    writeTranscript(transcriptPath, 4);
    const { database, indexer } = harness(claudeAdapter(transcriptPath));
    await indexer.recordWorkflowAgentTurns('project-1', OWNER);
    expect(ledger(database)).toHaveLength(4);

    writeTranscript(transcriptPath, 9);
    await indexer.recordWorkflowAgentTurns('project-1', OWNER);

    expect(ledger(database)).toHaveLength(9);
  });

  it('answers unsupported for an adapter with no transcript parser, and for a session type with no adapter', async () => {
    const noParser = harness({ displayName: 'No parser', locateSessionHistoryFile: async () => null });
    expect(await noParser.indexer.recordWorkflowAgentTurns('project-1', OWNER)).toBe('unsupported');
    expect(ledger(noParser.database)).toEqual([]);

    const noAdapter = harness(undefined);
    expect(await noAdapter.indexer.recordWorkflowAgentTurns('project-1', OWNER)).toBe('unsupported');
    expect(ledger(noAdapter.database)).toEqual([]);
  });

  it('answers missing-source for an empty transcript and for one that is not there, writing nothing', async () => {
    const emptyPath = temporaryFile('empty.jsonl');
    writeTranscript(emptyPath, 0);
    const empty = harness(claudeAdapter(emptyPath));
    expect(await empty.indexer.recordWorkflowAgentTurns('project-1', OWNER)).toBe('missing-source');
    expect(ledger(empty.database)).toEqual([]);

    const gone = harness({
      displayName: 'Gone',
      parseTranscriptWindow: async () => ({ entries: [], nextByteOffset: 0, totalBytes: 0, sourcePath: null }),
    });
    expect(await gone.indexer.recordWorkflowAgentTurns('project-1', OWNER)).toBe('missing-source');
    expect(ledger(gone.database)).toEqual([]);
  });

  it('supports an adapter that can only parse the whole transcript', async () => {
    const parseTranscript = vi.fn(async () => ({ entries: [], sourcePath: null }));
    const { indexer } = harness({ displayName: 'Whole file only', parseTranscript });

    expect(await indexer.recordWorkflowAgentTurns('project-1', OWNER)).toBe('missing-source');
    expect(parseTranscript).toHaveBeenCalledWith(AGENT_SESSION_ID, '/work', null);
  });

  it('never throws: a project database that will not open, or a parser that fails, answers error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noDatabase = new ConversationIndexer({
      getDb: () => {
        throw new Error('The project database is closed.');
      },
      getAdapter: () => claudeAdapter('/mock/never-read.jsonl') as never,
    });
    expect(await noDatabase.recordWorkflowAgentTurns('project-1', OWNER)).toBe('error');

    const failing = harness({
      displayName: 'Failing',
      parseTranscriptWindow: async () => {
        throw new Error('The transcript is unreadable.');
      },
    });
    expect(await failing.indexer.recordWorkflowAgentTurns('project-1', OWNER)).toBe('error');
    expect(ledger(failing.database)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(OWNER.sessionId);
  });
});
