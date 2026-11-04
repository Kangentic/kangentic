/**
 * An OpenCode 1 session's `task` subagents, read from `opencode.db`
 * (`subagent-usage.ts`). Rows are shaped from OpenCode 1.18.31's source: the
 * child session's `parent_id` (`packages/core/src/session/sql.ts`), the parent's
 * `task` part with `state.metadata.sessionId` naming the child and
 * `state.input.subagent_type` (`packages/opencode/src/tool/task.ts`), and each
 * assistant message's `tokens`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBetterSqlite3 } from '../../src/main/agent/adapters/opencode/session-history-parser';
import { readOpenCodeSubagentUsageAtPath, statOpenCodeSubagentsAtPath } from '../../src/main/agent/adapters/opencode/subagent-usage';

const ROOT = 'ses_root00000000000000000001';
const CHILD = 'ses_child0000000000000000001';
const GRANDCHILD = 'ses_grandchild00000000000001';

let directory: string;
let dbPath: string;

/**
 * The OpenCode 1 `session`, `message` and `part` tables and their indexes, as
 * read from a real OpenCode 1.18.31 `opencode.db` (FOREIGN KEY constraints
 * dropped so the tests need no `project` table).
 */
const OPENCODE_1_SCHEMA = `
CREATE TABLE \`session\` (\`id\` text PRIMARY KEY, \`project_id\` text NOT NULL, \`parent_id\` text, \`slug\` text NOT NULL, \`directory\` text NOT NULL, \`title\` text NOT NULL, \`version\` text NOT NULL, \`share_url\` text, \`summary_additions\` integer, \`summary_deletions\` integer, \`summary_files\` integer, \`summary_diffs\` text, \`revert\` text, \`permission\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`time_compacting\` integer, \`time_archived\` integer, \`workspace_id\` text, \`path\` text, \`agent\` text, \`model\` text, \`cost\` real DEFAULT 0 NOT NULL, \`tokens_input\` integer DEFAULT 0 NOT NULL, \`tokens_output\` integer DEFAULT 0 NOT NULL, \`tokens_reasoning\` integer DEFAULT 0 NOT NULL, \`tokens_cache_read\` integer DEFAULT 0 NOT NULL, \`tokens_cache_write\` integer DEFAULT 0 NOT NULL, \`metadata\` text);
CREATE TABLE \`message\` (\`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL);
CREATE TABLE \`part\` (\`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL);
CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);
CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);
CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);
`;

type TestDatabase = ReturnType<typeof openDatabase>;

function openDatabase() {
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) throw new Error('better-sqlite3 should load in the unit tier');
  return new DatabaseConstructor(dbPath);
}

function tokens(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output, reasoning: 0, total: input + output + cacheRead + cacheWrite, cache: { read: cacheRead, write: cacheWrite } };
}

/** Insert a session row, supplying the NOT NULL columns a real database requires. */
function insertSession(database: TestDatabase, id: string, parentId: string | null, createdMs: number, updatedMs: number): void {
  database
    .prepare('INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'proj_test', parentId, `slug-${id}`, '/repo', 'Test session', '1.18.31', createdMs, updatedMs);
}

/** An assistant message `data` with the keys a real 1.18.31 database holds. */
function realAssistantData(mode: string, modelId: string, createdMs: number, messageTokens: ReturnType<typeof tokens>) {
  return {
    role: 'assistant',
    agent: mode,
    mode,
    modelID: modelId,
    providerID: 'anthropic',
    parentID: 'msg_parent',
    path: { cwd: '/repo', root: '/repo' },
    finish: 'stop',
    cost: 0.001,
    tokens: messageTokens,
    time: { created: createdMs, completed: createdMs + 400 },
  };
}

/** A `task` tool part `data` in the real 1.18.31 shape. */
function taskPartData(callId: string, subagentType: string, childId: string | null, parentId: string): string {
  return JSON.stringify({
    type: 'tool', tool: 'task', callID: callId,
    state: {
      status: 'completed',
      title: 'Explore',
      input: { description: 'Explore', prompt: 'Find it', subagent_type: subagentType },
      metadata: { sessionId: childId, parentSessionId: parentId, model: { modelID: 'claude-haiku-4-5', providerID: 'anthropic' }, truncated: false },
      output: 'done',
      time: { start: 1200, end: 1300 },
    },
  });
}

/** A root that spawned an explore subagent, which spawned a general one of its own. */
function buildDatabase(): void {
  const database = openDatabase();
  database.exec(OPENCODE_1_SCHEMA);
  insertSession(database, ROOT, null, 1000, 1000);
  insertSession(database, CHILD, ROOT, 2000, 2000);
  insertSession(database, GRANDCHILD, CHILD, 3000, 3000);
  insertSession(database, 'ses_unrelated', null, 1500, 1500);
  const message = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const part = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  message.run('msg_root_a', ROOT, 1100, 1100, JSON.stringify({ role: 'assistant', modelID: 'claude-sonnet-4-5', tokens: tokens(100, 10) }));
  part.run('prt_root_task', 'msg_root_a', ROOT, 1200, 1200, taskPartData('call_root_task', 'explore', CHILD, ROOT));
  message.run('msg_child_u', CHILD, 2050, 2050, JSON.stringify({ role: 'user' }));
  message.run('msg_child_a1', CHILD, 2100, 2500, JSON.stringify(realAssistantData('explore', 'claude-haiku-4-5', 2100, tokens(500, 50, 1000, 20))));
  part.run('prt_child_task', 'msg_child_a1', CHILD, 2200, 2600, JSON.stringify({
    type: 'tool', callID: 'call_child_task', tool: 'task',
    state: { status: 'completed', input: { subagent_type: 'general' }, metadata: { sessionId: GRANDCHILD } },
  }));
  // An answer with no tokens is left out of the ledger.
  message.run('msg_child_a2', CHILD, 2700, 2700, JSON.stringify({ role: 'assistant', modelID: 'claude-haiku-4-5', tokens: tokens(0, 0) }));
  message.run('msg_grand_a', GRANDCHILD, 3100, 3900, JSON.stringify({ role: 'assistant', modelID: 'claude-haiku-4-5', time: { created: 3100 }, tokens: tokens(80, 8) }));
  database.close();
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-subagents-'));
  dbPath = path.join(directory, 'opencode.db');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('readOpenCodeSubagentUsageAtPath', () => {
  it('reads each subagent answer as one turn, with its child session, spawning call, type and depth', () => {
    buildDatabase();
    const parsed = readOpenCodeSubagentUsageAtPath(dbPath, ROOT);
    expect(parsed.directoryPresent).toBe(true);
    expect(parsed.complete).toBe(true);
    expect(parsed.turns).toEqual([
      {
        turnUuid: 'msg_child_a1', subagentId: CHILD, agentType: 'explore', spawnDepth: 1, parentToolUseId: 'call_root_task',
        ts: 2100, model: 'claude-haiku-4-5', usage: { inputTokens: 500, outputTokens: 50, cacheCreationInputTokens: 20, cacheReadInputTokens: 1000 },
      },
      {
        turnUuid: 'msg_grand_a', subagentId: GRANDCHILD, agentType: 'general', spawnDepth: 2, parentToolUseId: 'call_child_task',
        ts: 3100, model: 'claude-haiku-4-5', usage: { inputTokens: 80, outputTokens: 8, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
    ]);
  });

  it('links only the spawning calls a subagent made, so a nested one resolves to its parent subagent', () => {
    buildDatabase();
    expect(readOpenCodeSubagentUsageAtPath(dbPath, ROOT).spawnLinks).toEqual([
      { toolUseId: 'call_child_task', turnUuid: 'msg_child_a1' },
    ]);
  });

  it('reports a session with no subagents as a coverage gap, and an unreadable database as incomplete', () => {
    buildDatabase();
    expect(readOpenCodeSubagentUsageAtPath(dbPath, 'ses_unrelated')).toMatchObject({ directoryPresent: false, complete: true, turns: [] });
    expect(readOpenCodeSubagentUsageAtPath(path.join(directory, 'missing.db'), ROOT)).toMatchObject({ directoryPresent: false, complete: false });
  });

  it('stops following a chain of subagents at depth 8', () => {
    const database = openDatabase();
    database.exec(OPENCODE_1_SCHEMA);
    insertSession(database, ROOT, null, 1000, 1000);
    const message = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    let parentId = ROOT;
    for (let level = 1; level <= 10; level += 1) {
      const childId = `ses_chain_${level}`;
      insertSession(database, childId, parentId, 1000 + level, 1000 + level);
      message.run(`msg_chain_${level}`, childId, 2000 + level, 2000 + level, JSON.stringify({ role: 'assistant', tokens: tokens(1, 1) }));
      parentId = childId;
    }
    database.close();
    const parsed = readOpenCodeSubagentUsageAtPath(dbPath, ROOT);
    expect(parsed.turns.map((turn) => turn.spawnDepth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parsed.turns[7].subagentId).toBe('ses_chain_8');
    expect(statOpenCodeSubagentsAtPath(dbPath, ROOT)?.fileCount).toBe(8);
  });

  it('ends a parent_id cycle, reading each session once', () => {
    const database = openDatabase();
    database.exec(OPENCODE_1_SCHEMA);
    // ROOT -> A -> B, and ROOT names B as its own parent.
    insertSession(database, ROOT, 'ses_cycle_b', 1000, 1000);
    insertSession(database, 'ses_cycle_a', ROOT, 2000, 2000);
    insertSession(database, 'ses_cycle_b', 'ses_cycle_a', 3000, 3000);
    const message = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    message.run('msg_cycle_a', 'ses_cycle_a', 2100, 2100, JSON.stringify({ role: 'assistant', tokens: tokens(1, 1) }));
    message.run('msg_cycle_b', 'ses_cycle_b', 3100, 3100, JSON.stringify({ role: 'assistant', tokens: tokens(1, 1) }));
    database.close();
    const parsed = readOpenCodeSubagentUsageAtPath(dbPath, ROOT);
    expect(parsed.turns.map((turn) => [turn.subagentId, turn.spawnDepth])).toEqual([['ses_cycle_a', 1], ['ses_cycle_b', 2]]);
  });

  it('falls back to the child answer\'s mode for the type when no task call names the child, and to the row time for ts', () => {
    const database = openDatabase();
    database.exec(OPENCODE_1_SCHEMA);
    insertSession(database, ROOT, null, 1000, 1000);
    insertSession(database, CHILD, ROOT, 2000, 2000);
    database
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
      .run('msg_child_a', CHILD, 2222, 2300, JSON.stringify({ role: 'assistant', mode: 'plan', tokens: tokens(7, 3) }));
    database.close();
    expect(readOpenCodeSubagentUsageAtPath(dbPath, ROOT).turns).toEqual([
      {
        turnUuid: 'msg_child_a', subagentId: CHILD, agentType: 'plan', spawnDepth: 1, parentToolUseId: null,
        ts: 2222, model: null, usage: { inputTokens: 7, outputTokens: 3, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
    ]);
  });

  it('still links a task call made inside a subagent answer that has no usage', () => {
    const database = openDatabase();
    database.exec(OPENCODE_1_SCHEMA);
    insertSession(database, ROOT, null, 1000, 1000);
    insertSession(database, CHILD, ROOT, 2000, 2000);
    insertSession(database, GRANDCHILD, CHILD, 3000, 3000);
    database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_child_zero', CHILD, 2100, 2100, JSON.stringify({ role: 'assistant', tokens: tokens(0, 0) }));
    database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('prt_child_task', 'msg_child_zero', CHILD, 2200, 2200, taskPartData('call_child_task', 'general', GRANDCHILD, CHILD));
    database.close();
    const parsed = readOpenCodeSubagentUsageAtPath(dbPath, ROOT);
    expect(parsed.turns).toEqual([]);
    expect(parsed.spawnLinks).toEqual([{ toolUseId: 'call_child_task', turnUuid: 'msg_child_zero' }]);
  });

  it('reads no subagents from a session table that has no parent_id column', () => {
    const database = openDatabase();
    database.exec('CREATE TABLE session (id TEXT PRIMARY KEY)');
    database.close();
    expect(readOpenCodeSubagentUsageAtPath(dbPath, ROOT)).toMatchObject({ directoryPresent: false, complete: true, turns: [] });
    expect(statOpenCodeSubagentsAtPath(dbPath, ROOT)).toBeNull();
  });

  it('reads no subagents from a database with no session table (OpenCode 2 only)', () => {
    const DatabaseConstructor = loadBetterSqlite3();
    if (!DatabaseConstructor) throw new Error('better-sqlite3 should load in the unit tier');
    const database = new DatabaseConstructor(dbPath);
    database.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
    database.close();
    expect(readOpenCodeSubagentUsageAtPath(dbPath, ROOT)).toMatchObject({ directoryPresent: false, complete: true });
    expect(statOpenCodeSubagentsAtPath(dbPath, ROOT)).toBeNull();
  });
});

describe('statOpenCodeSubagentsAtPath', () => {
  it('signs the subagent sessions: their count, stored size and newest update', () => {
    buildDatabase();
    const signature = statOpenCodeSubagentsAtPath(dbPath, ROOT);
    expect(signature?.fileCount).toBe(2);
    expect(signature?.maxMtimeMs).toBe(3900);
    expect(signature?.totalSize).toBeGreaterThan(0);
  });

  it('moves by the bytes of a child part that grows, not its characters', () => {
    buildDatabase();
    const before = statOpenCodeSubagentsAtPath(dbPath, ROOT);
    const partData = JSON.stringify({ type: 'text', text: 'é'.repeat(50) });
    const database = openDatabase();
    database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('prt_child_text', 'msg_child_a1', CHILD, 2300, 2300, partData);
    database.close();
    const after = statOpenCodeSubagentsAtPath(dbPath, ROOT);
    expect(Buffer.byteLength(partData)).toBeGreaterThan(partData.length);
    expect((after?.totalSize ?? 0) - (before?.totalSize ?? 0)).toBe(Buffer.byteLength(partData));
  });

  it('moves when a subagent writes, and is null for a session with none', () => {
    buildDatabase();
    const before = statOpenCodeSubagentsAtPath(dbPath, ROOT);
    const DatabaseConstructor = loadBetterSqlite3();
    if (!DatabaseConstructor) throw new Error('better-sqlite3 should load in the unit tier');
    const database = new DatabaseConstructor(dbPath);
    database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_grand_b', GRANDCHILD, 4000, 4000, JSON.stringify({ role: 'assistant', tokens: tokens(1, 1) }));
    database.close();
    const after = statOpenCodeSubagentsAtPath(dbPath, ROOT);
    expect(after?.totalSize).toBeGreaterThan(before?.totalSize ?? 0);
    expect(after?.maxMtimeMs).toBe(4000);
    expect(statOpenCodeSubagentsAtPath(dbPath, 'ses_unrelated')).toBeNull();
  });
});
