/**
 * Lifetime tokens and tool calls of an OpenCode session, read from its local
 * `opencode.db` (`transcript-usage.ts`). The rows are shaped like OpenCode
 * 1.18.31's `message` / `part` tables (an assistant message's `tokens` and
 * `cost` from `AssistantMessage` in `@opencode-ai/sdk`, a tool part's `callID`
 * and `tool` from `ToolPart`) and OpenCode 2's `session_message` records.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBetterSqlite3 } from '../../src/main/agent/adapters/opencode/session-history-parser';
import {
  readOpenCodeToolCountsAtPath,
  readOpenCodeToolResultTokensAtPath,
  readOpenCodeTranscriptUsageAtPath,
} from '../../src/main/agent/adapters/opencode/transcript-usage';
import { parseOpenCodeTranscriptAtPath, readOpenCodeTranscriptWindowAtPath } from '../../src/main/agent/adapters/opencode/transcript-parser';

const SESSION = 'ses_usage000000000000000001';

let directory: string;
let dbPath: string;

function openDatabase() {
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) throw new Error('better-sqlite3 should load in the unit tier');
  return new DatabaseConstructor(dbPath);
}

/**
 * The OpenCode 1 `message` and `part` tables and their indexes, as read from a
 * real OpenCode 1.18.31 `opencode.db` (FOREIGN KEY constraints dropped so the
 * tests need no `project` or `session` table).
 */
const OPENCODE_1_SCHEMA = `
CREATE TABLE \`message\` (\`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL);
CREATE TABLE \`part\` (\`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL);
CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);
CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);
`;

function createTables(database: ReturnType<typeof openDatabase>): void {
  database.exec(OPENCODE_1_SCHEMA);
  database.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
}

function assistantTokens(input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number) {
  return { input, output, reasoning, total: input + output + reasoning + cacheRead + cacheWrite, cache: { read: cacheRead, write: cacheWrite } };
}

/** An assistant message `data` with the keys a real 1.18.31 database holds. */
function realAssistantData(cost: number, tokens: ReturnType<typeof assistantTokens>, createdMs: number) {
  return {
    role: 'assistant',
    agent: 'build',
    mode: 'build',
    modelID: 'claude-sonnet-4-5',
    providerID: 'anthropic',
    parentID: 'msg_user',
    path: { cwd: '/repo', root: '/repo' },
    finish: 'stop',
    cost,
    tokens,
    time: { created: createdMs, completed: createdMs + 100 },
  };
}

/** A tool part `data`: the OpenCode 1 `ToolPart` shape. */
function toolPartData(callId: string, tool: string, output: string): string {
  return JSON.stringify({ type: 'tool', callID: callId, tool, state: { status: 'completed', input: {}, output } });
}

/** A session with one tool part at each of 1000, 2000 and 3000, the tool named by its time and returning 4, 8 and 12 characters. */
function buildTimedToolParts(): void {
  const database = openDatabase();
  createTables(database);
  const insertPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  insertPart.run('prt_t1', 'msg_a', SESSION, 1000, 1000, toolPartData('call_t1', 'tool_1000', 'a'.repeat(4)));
  insertPart.run('prt_t2', 'msg_a', SESSION, 2000, 2000, toolPartData('call_t2', 'tool_2000', 'b'.repeat(8)));
  insertPart.run('prt_t3', 'msg_a', SESSION, 3000, 3000, toolPartData('call_t3', 'tool_3000', 'c'.repeat(12)));
  database.close();
}

/** An OpenCode 2 session with one assistant record, holding one tool, at each of 1000, 2000 and 3000. */
function buildTimedV2Records(): void {
  const database = openDatabase();
  createTables(database);
  const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
  [1000, 2000, 3000].forEach((createdMs, index) => {
    insert.run(`m${index}`, SESSION, 'assistant', index + 1, createdMs, createdMs, JSON.stringify({
      content: [{ type: 'tool', id: `call_${createdMs}`, name: `tool_${createdMs}`, state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'z'.repeat(4 * (index + 1)) }] } }],
    }));
  });
  database.close();
}

/** An OpenCode 1 session: a prompt and two answers, the second calling two tools (one streamed twice). */
function buildV1Session(): void {
  const database = openDatabase();
  createTables(database);
  const insertMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const insertPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  insertMessage.run('msg_user', SESSION, 1000, 1000, JSON.stringify({ role: 'user', time: { created: 1000 } }));
  insertMessage.run('msg_a1', SESSION, 2000, 2000, JSON.stringify({ role: 'assistant', cost: 0.01, tokens: assistantTokens(1200, 300, 50, 8000, 400) }));
  insertMessage.run('msg_a2', SESSION, 5000, 5000, JSON.stringify(realAssistantData(0.02, assistantTokens(600, 900, 0, 9600, 200), 5000)));
  insertPart.run('prt_text', 'msg_a1', SESSION, 2000, 2000, JSON.stringify({ type: 'text', text: 'Looking.' }));
  insertPart.run('prt_bash', 'msg_a1', SESSION, 2100, 2100, JSON.stringify({ type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a'.repeat(400) } }));
  insertPart.run('prt_edit', 'msg_a2', SESSION, 5100, 5100, JSON.stringify({ type: 'tool', callID: 'call_2', tool: 'edit', state: { status: 'completed', input: { filePath: '/repo/a.ts' }, output: 'Edit applied.' } }));
  insertPart.run('prt_bash2', 'msg_a2', SESSION, 5200, 5200, JSON.stringify({ type: 'tool', callID: 'call_3', tool: 'bash', state: { status: 'error', error: 'x'.repeat(40) } }));
  // The same call stored again (a part row per state) still counts once, at its last result.
  insertPart.run('prt_bash2b', 'msg_a2', SESSION, 5300, 5300, JSON.stringify({ type: 'tool', callID: 'call_3', tool: 'bash', state: { status: 'completed', output: 'y'.repeat(80) } }));
  // Another session's row is not this one's.
  insertMessage.run('msg_other', 'ses_other', 3000, 3000, JSON.stringify({ role: 'assistant', tokens: assistantTokens(99999, 99999, 0, 0, 0) }));
  database.close();
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-usage-'));
  dbPath = path.join(directory, 'opencode.db');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('readOpenCodeTranscriptUsageAtPath', () => {
  it('sums every answer: input with the cache read and written, output with reasoning', () => {
    buildV1Session();
    expect(readOpenCodeTranscriptUsageAtPath(dbPath, SESSION)).toEqual({
      inputTokens: (1200 + 8000 + 400) + (600 + 9600 + 200),
      outputTokens: (300 + 50) + 900,
    });
  });

  it('reads an OpenCode 2 session from session_message', () => {
    const database = openDatabase();
    createTables(database);
    const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('m1', SESSION, 'user', 1, 1000, 1000, JSON.stringify({ text: 'hi' }));
    insert.run('m2', SESSION, 'assistant', 2, 2000, 2000, JSON.stringify({ content: [], tokens: assistantTokens(100, 20, 5, 1000, 10) }));
    database.close();
    expect(readOpenCodeTranscriptUsageAtPath(dbPath, SESSION)).toEqual({ inputTokens: 1110, outputTokens: 25 });
  });

  it('counts only assistant messages, so a user message carrying tokens is ignored', () => {
    const database = openDatabase();
    createTables(database);
    const insertMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    insertMessage.run('msg_user', SESSION, 1000, 1000, JSON.stringify({ role: 'user', tokens: assistantTokens(5000, 5000, 0, 0, 0) }));
    insertMessage.run('msg_a1', SESSION, 2000, 2000, JSON.stringify(realAssistantData(0.01, assistantTokens(10, 2, 0, 0, 0), 2000)));
    database.close();
    expect(readOpenCodeTranscriptUsageAtPath(dbPath, SESSION)).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it('answers null for a session with no answer, and for no database', () => {
    const database = openDatabase();
    createTables(database);
    database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_user', SESSION, 1000, 1000, JSON.stringify({ role: 'user' }));
    database.close();
    expect(readOpenCodeTranscriptUsageAtPath(dbPath, SESSION)).toBeNull();
    expect(readOpenCodeTranscriptUsageAtPath(path.join(directory, 'missing.db'), SESSION)).toBeNull();
  });
});

describe('readOpenCodeTranscriptUsageAtPath with an answer still in flight', () => {
  const ZERO_TOKENS = assistantTokens(0, 0, 0, 0, 0);

  it('answers null for an OpenCode 1 session whose only answer has every count 0', () => {
    const database = openDatabase();
    createTables(database);
    database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_a1', SESSION, 2000, 2000, JSON.stringify({ role: 'assistant', tokens: ZERO_TOKENS }));
    database.close();
    expect(readOpenCodeTranscriptUsageAtPath(dbPath, SESSION)).toBeNull();
  });

  it('sums only the finished answer when an OpenCode 1 session also has an all-zero in-flight one', () => {
    const database = openDatabase();
    createTables(database);
    const insertMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    insertMessage.run('msg_a1', SESSION, 2000, 2000, JSON.stringify({ role: 'assistant', tokens: assistantTokens(100, 20, 5, 1000, 10) }));
    insertMessage.run('msg_a2', SESSION, 3000, 3000, JSON.stringify({ role: 'assistant', tokens: ZERO_TOKENS }));
    database.close();
    expect(readOpenCodeTranscriptUsageAtPath(dbPath, SESSION)).toEqual({ inputTokens: 1110, outputTokens: 25 });
  });

  it('answers null for an OpenCode 2 session whose only answer has every count 0', () => {
    const database = openDatabase();
    createTables(database);
    database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', SESSION, 'assistant', 1, 1000, 1000, JSON.stringify({ content: [], tokens: ZERO_TOKENS }));
    database.close();
    expect(readOpenCodeTranscriptUsageAtPath(dbPath, SESSION)).toBeNull();
  });

  it('sums only the finished answer when an OpenCode 2 session also has an all-zero in-flight one', () => {
    const database = openDatabase();
    createTables(database);
    const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('m1', SESSION, 'assistant', 1, 1000, 1000, JSON.stringify({ content: [], tokens: assistantTokens(100, 20, 5, 1000, 10) }));
    insert.run('m2', SESSION, 'assistant', 2, 2000, 2000, JSON.stringify({ content: [], tokens: ZERO_TOKENS }));
    database.close();
    expect(readOpenCodeTranscriptUsageAtPath(dbPath, SESSION)).toEqual({ inputTokens: 1110, outputTokens: 25 });
  });
});

describe('readOpenCodeToolResultTokensAtPath error results and duplicate ids', () => {
  it('sizes an OpenCode 1 tool part with only a string error by that error', () => {
    const database = openDatabase();
    createTables(database);
    database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('prt_err', 'msg_a', SESSION, 1000, 1000, JSON.stringify({
      type: 'tool', callID: 'call_err', tool: 'failing_tool', state: { status: 'error', error: 'e'.repeat(36) },
    }));
    database.close();
    expect(readOpenCodeToolResultTokensAtPath(dbPath, SESSION)).toEqual({ failing_tool: 9 });
  });

  it('sizes an OpenCode 2 tool by a string state.error and by a state.error message', () => {
    const database = openDatabase();
    createTables(database);
    database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', SESSION, 'assistant', 1, 1000, 1000, JSON.stringify({
      content: [
        { type: 'tool', id: 'call_string_error', name: 'string_error_tool', state: { status: 'error', input: {}, error: 'a'.repeat(20) } },
        { type: 'tool', id: 'call_object_error', name: 'object_error_tool', state: { status: 'error', input: {}, error: { type: 'x', message: 'b'.repeat(12) } } },
      ],
    }));
    database.close();
    expect(readOpenCodeToolResultTokensAtPath(dbPath, SESSION)).toEqual({ string_error_tool: 5, object_error_tool: 3 });
  });

  it('counts an OpenCode 2 call stored in two records once, at its last stored result', () => {
    const database = openDatabase();
    createTables(database);
    const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    const recordWithResult = (text: string) => JSON.stringify({
      content: [{ type: 'tool', id: 'call_dup', name: 'dup_tool', state: { status: 'completed', input: {}, content: [{ type: 'text', text }] } }],
    });
    insert.run('m1', SESSION, 'assistant', 1, 1000, 1000, recordWithResult('p'.repeat(40)));
    insert.run('m2', SESSION, 'assistant', 2, 2000, 2000, recordWithResult('q'.repeat(8)));
    database.close();
    expect(readOpenCodeToolResultTokensAtPath(dbPath, SESSION)).toEqual({ dup_tool: 2 });
    expect(readOpenCodeToolCountsAtPath(dbPath, SESSION)).toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'dup_tool', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }],
    });
  });
});

describe('readOpenCodeToolResultTokensAtPath', () => {
  it('estimates each tool\'s returned text at four characters a token, a call once at its last result', () => {
    buildV1Session();
    expect(readOpenCodeToolResultTokensAtPath(dbPath, SESSION)).toEqual({
      bash: 400 / 4 + 80 / 4,
      edit: Math.ceil('Edit applied.'.length / 4),
    });
  });

  it('keeps to the window, and answers an empty object for a window with no call', () => {
    buildV1Session();
    expect(readOpenCodeToolResultTokensAtPath(dbPath, SESSION, { sinceMs: 2000, untilMs: 5000 })).toEqual({ bash: 100 });
    expect(readOpenCodeToolResultTokensAtPath(dbPath, SESSION, { sinceMs: 9000 })).toEqual({});
  });

  it('counts a call at exactly sinceMs and leaves out one at exactly untilMs', () => {
    buildTimedToolParts();
    expect(readOpenCodeToolResultTokensAtPath(dbPath, SESSION, { sinceMs: 2000, untilMs: 3000 })).toEqual({ tool_2000: 2 });
  });

  it('keeps an OpenCode 2 session to the same window, since inclusive and until exclusive', () => {
    buildTimedV2Records();
    expect(readOpenCodeToolResultTokensAtPath(dbPath, SESSION, { sinceMs: 2000, untilMs: 3000 })).toEqual({ tool_2000: 2 });
  });

  it('answers null when the database cannot be read', () => {
    expect(readOpenCodeToolResultTokensAtPath(path.join(directory, 'missing.db'), SESSION)).toBeNull();
  });

  it('reads an OpenCode 2 tool\'s content text', () => {
    const database = openDatabase();
    createTables(database);
    database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', SESSION, 'assistant', 1, 1000, 1000, JSON.stringify({
      content: [{ type: 'tool', id: 'call_a', name: 'read', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'z'.repeat(40) }] } }],
    }));
    database.close();
    expect(readOpenCodeToolResultTokensAtPath(dbPath, SESSION)).toEqual({ read: 10 });
  });
});

describe('per-turn usage on transcript entries', () => {
  it('puts each answer\'s tokens on its assistant entry', () => {
    buildV1Session();
    const assistants = parseOpenCodeTranscriptAtPath(dbPath, SESSION).filter((entry) => entry.kind === 'assistant');
    expect(assistants.map((entry) => (entry.kind === 'assistant' ? entry.usage : null))).toEqual([
      { inputTokens: 1200, outputTokens: 350, cacheCreationInputTokens: 400, cacheReadInputTokens: 8000 },
      { inputTokens: 600, outputTokens: 900, cacheCreationInputTokens: 200, cacheReadInputTokens: 9600 },
    ]);
  });
});

describe('readOpenCodeTranscriptWindowAtPath', () => {
  it('walks the whole session window by window, one message at least, ending at totalBytes', () => {
    buildV1Session();
    const seen: string[] = [];
    let offset = 0;
    let totalBytes = Number.POSITIVE_INFINITY;
    for (let step = 0; step < 10 && offset < totalBytes; step += 1) {
      const window = readOpenCodeTranscriptWindowAtPath(dbPath, SESSION, offset, 1);
      expect(window.firstByteOffset).toBe(offset);
      expect(window.endByte).toBe(window.nextByteOffset);
      expect(window.nextByteOffset).toBeGreaterThan(offset);
      for (const entry of window.entries) if (!seen.includes(entry.uuid)) seen.push(entry.uuid);
      offset = window.nextByteOffset;
      totalBytes = window.totalBytes;
    }
    expect(offset).toBe(totalBytes);
    // Every message the tail parse reads, the walk reads too.
    expect(seen).toEqual([...new Set(parseOpenCodeTranscriptAtPath(dbPath, SESSION).map((entry) => entry.uuid))]);
  });

  it('reads the whole session in one window when the budget holds it', () => {
    buildV1Session();
    const window = readOpenCodeTranscriptWindowAtPath(dbPath, SESSION, 0, 1_000_000);
    expect(window.nextByteOffset).toBe(window.totalBytes);
    expect(window.entries.filter((entry) => entry.kind === 'assistant').map((entry) => entry.uuid)).toEqual(['msg_a1', 'msg_a2']);
  });

  it('reads nothing past the end, and nothing from no database', () => {
    buildV1Session();
    const end = readOpenCodeTranscriptWindowAtPath(dbPath, SESSION, 0, 1_000_000).totalBytes;
    expect(readOpenCodeTranscriptWindowAtPath(dbPath, SESSION, end, 100).entries).toEqual([]);
    expect(readOpenCodeTranscriptWindowAtPath(path.join(directory, 'missing.db'), SESSION, 0, 100).entries).toEqual([]);
  });
});

describe('readOpenCodeToolCountsAtPath', () => {
  it('counts distinct calls by tool name, most used first', () => {
    buildV1Session();
    expect(readOpenCodeToolCountsAtPath(dbPath, SESSION)).toEqual({
      toolCallCount: 3,
      toolBreakdown: [
        { toolName: 'bash', callCount: 2, totalDurationMs: 0, interruptedCount: 0 },
        { toolName: 'edit', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
      ],
    });
  });

  it('keeps to the calls made at or after sinceMs and before untilMs', () => {
    buildV1Session();
    expect(readOpenCodeToolCountsAtPath(dbPath, SESSION, { sinceMs: 5000 })?.toolCallCount).toBe(2);
    expect(readOpenCodeToolCountsAtPath(dbPath, SESSION, { sinceMs: 2000, untilMs: 5000 })).toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'bash', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }],
    });
    expect(readOpenCodeToolCountsAtPath(dbPath, SESSION, { sinceMs: 9000 })).toBeNull();
  });

  it('counts a call at exactly sinceMs and leaves out one at exactly untilMs', () => {
    buildTimedToolParts();
    expect(readOpenCodeToolCountsAtPath(dbPath, SESSION, { sinceMs: 2000, untilMs: 3000 })).toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'tool_2000', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }],
    });
  });

  it('keeps an OpenCode 2 session to the same window, since inclusive and until exclusive', () => {
    buildTimedV2Records();
    expect(readOpenCodeToolCountsAtPath(dbPath, SESSION, { sinceMs: 2000, untilMs: 3000 })?.toolBreakdown.map((row) => row.toolName))
      .toEqual(['tool_2000']);
  });

  it('ignores a part that is not a tool, even one with a call id and tool name', () => {
    const database = openDatabase();
    createTables(database);
    const insertPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
    insertPart.run('prt_text', 'msg_a', SESSION, 1000, 1000, JSON.stringify({ type: 'text', text: 'hello', callID: 'call_fake', tool: 'bash' }));
    insertPart.run('prt_task', 'msg_a', SESSION, 1100, 1100, JSON.stringify({
      type: 'tool', tool: 'task', callID: 'call_task',
      state: { status: 'completed', title: 'Explore', input: { description: 'Explore', prompt: 'Find it', subagent_type: 'explore' }, metadata: { sessionId: 'ses_child', parentSessionId: SESSION, model: { modelID: 'm', providerID: 'p' }, truncated: false }, output: 'done', time: { start: 1100, end: 1200 } },
    }));
    database.close();
    expect(readOpenCodeToolCountsAtPath(dbPath, SESSION)).toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'task', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }],
    });
  });

  it('reads an OpenCode 2 session\'s tool content', () => {
    const database = openDatabase();
    createTables(database);
    const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('m1', SESSION, 'assistant', 1, 1000, 1000, JSON.stringify({
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool', id: 'call_a', name: 'read', state: { status: 'completed', input: {}, content: [] } },
        { type: 'tool', id: 'call_b', name: 'shell', state: { status: 'error', input: {}, error: { type: 'x', message: 'y' } } },
      ],
    }));
    database.close();
    expect(readOpenCodeToolCountsAtPath(dbPath, SESSION)?.toolBreakdown.map((row) => [row.toolName, row.callCount]))
      .toEqual([['read', 1], ['shell', 1]]);
  });
});
