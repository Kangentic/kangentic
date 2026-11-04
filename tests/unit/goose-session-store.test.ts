/**
 * Goose's session store (`session-store.ts`) and the conversation read from it
 * (`transcript-parser.ts`).
 *
 * Goose was not installed where this was written, so the fixture database is
 * built with the tables Goose's source creates at 1.57.0
 * (`crates/goose/src/session/session_manager.rs`, schema version 17) and the
 * content blocks its message type serializes
 * (`crates/goose-provider-types/src/conversation/message.rs`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findGooseSession,
  gooseDataDirectory,
  gooseDatabaseStamp,
  gooseSessionUsage,
  readGooseSession,
  withGooseDatabase,
  type GooseSessionRow,
} from '../../src/main/agent/adapters/goose/session-store';
import { loadBetterSqlite3 } from '../../src/main/agent/shared/sqlite-loader';
import {
  mapGooseRows,
  readGooseTail,
  readGooseToolCounts,
  readGooseToolResultTokens,
  readGooseTranscriptPage,
  readGooseTranscriptUsage,
  type GooseMessageRow,
} from '../../src/main/agent/adapters/goose/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import { GooseAdapter } from '../../src/main/agent/adapters/goose';
import type { SessionUsage, TranscriptEntry } from '../../src/shared/types';

const SESSIONS_TABLE = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', user_set_name BOOLEAN DEFAULT FALSE,
  session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, extension_data TEXT DEFAULT '{}', total_tokens INTEGER, input_tokens INTEGER,
  output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, accumulated_total_tokens INTEGER,
  accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER,
  accumulated_cache_write_tokens INTEGER, accumulated_cost REAL, schedule_id TEXT, recipe_json TEXT,
  user_recipe_values_json TEXT, provider_name TEXT, model_config_json TEXT, goose_mode TEXT NOT NULL DEFAULT 'auto',
  archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT
)`;
const MESSAGES_TABLE = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT
)`;

const NAME = '6f0c1a52-4c1e-4b6e-9d7f-0a1b2c3d4e5f';
const GOOSE_ID = '20261103_4';

function text(value: string): object {
  return { type: 'text', text: value };
}
function toolRequest(id: string, name: string, args: object): object {
  return { type: 'toolRequest', id, toolCall: { status: 'success', value: { name, arguments: args } } };
}
function toolResponse(id: string, output: string, isError = false): object {
  return { type: 'toolResponse', id, toolResult: { status: 'success', value: { content: [text(output)], isError } } };
}

let rootDirectory: string;
let dbPath: string;

interface MessageSeed {
  role: 'user' | 'assistant';
  content: object[];
  /** Seconds, as Goose stores them. */
  at: number;
  metadata?: object;
}

function createDatabase(messages: MessageSeed[], sessionOverrides: Record<string, unknown> = {}): void {
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) throw new Error('better-sqlite3 failed to load');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseConstructor(dbPath);
  database.pragma('journal_mode = WAL');
  database.exec(SESSIONS_TABLE);
  database.exec(MESSAGES_TABLE);
  const session = {
    id: GOOSE_ID,
    name: NAME,
    user_set_name: 1,
    working_dir: '/projects/my-app',
    created_at: '2026-11-03 10:00:00',
    total_tokens: 12000,
    input_tokens: 11000,
    output_tokens: 1000,
    cache_read_tokens: 4000,
    accumulated_input_tokens: 30000,
    accumulated_output_tokens: 2500,
    accumulated_cost: 0.42,
    model_config_json: JSON.stringify({ model_name: 'gpt-4o', context_limit: 128000, temperature: null }),
    ...sessionOverrides,
  };
  const columns = Object.keys(session);
  database.prepare(`INSERT INTO sessions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(session));
  // Another session, so every read must scope to the named one.
  database.prepare('INSERT INTO sessions (id, name, working_dir) VALUES (?, ?, ?)').run('20261103_1', 'other', '/projects/other');
  database.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)')
    .run('20261103_1', 'user', JSON.stringify([text('another session')]), 1_000);
  const insert = database.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?)');
  for (const message of messages) {
    insert.run(GOOSE_ID, message.role, JSON.stringify(message.content), message.at, message.metadata ? JSON.stringify(message.metadata) : null);
  }
  database.close();
}

function openDatabase(): DatabaseType.Database {
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) throw new Error('better-sqlite3 failed to load');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return new DatabaseConstructor(dbPath);
}

/** The tables with no session row yet, as a Goose that has not written its row. */
function createEmptyDatabase(): void {
  const database = openDatabase();
  database.pragma('journal_mode = WAL');
  database.exec(SESSIONS_TABLE);
  database.exec(MESSAGES_TABLE);
  database.close();
}

function insertSessionRow(totalTokens: number): void {
  const database = openDatabase();
  database.prepare('INSERT INTO sessions (id, name, working_dir, total_tokens, model_config_json) VALUES (?, ?, ?, ?, ?)')
    .run(GOOSE_ID, NAME, '/projects/my-app', totalTokens, JSON.stringify({ model_name: 'gpt-4o', context_limit: 128000 }));
  database.close();
}

function updateTotalTokens(totalTokens: number): void {
  const database = openDatabase();
  database.prepare('UPDATE sessions SET total_tokens = ? WHERE id = ?').run(totalTokens, GOOSE_ID);
  database.close();
}

/**
 * Leave WAL mode so the change stamp is the database file's alone: a WAL file
 * appears and disappears with each connection and would move the stamp on its
 * own, which these tests need to control.
 */
function useRollbackJournal(): void {
  const database = openDatabase();
  database.pragma('journal_mode = DELETE');
  database.close();
}

/** Pin the database file's mtime to a whole second, so a test controls the change stamp exactly. */
function setDatabaseMtime(secondsAfterBase: number): void {
  const seconds = 1_800_000_000 + secondsAfterBase;
  fs.utimesSync(dbPath, seconds, seconds);
}

const CONVERSATION: MessageSeed[] = [
  { role: 'user', content: [text('Fix the login redirect')], at: 1_800_000_000 },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'Look at the router.', signature: 'x' }, text('Reading the router.'), toolRequest('call_1', 'shell', { command: 'rg redirect' })], at: 1_800_000_010 },
  { role: 'user', content: [toolResponse('call_1', 'src/router.ts:12: redirect()')], at: 1_800_000_011 },
  { role: 'assistant', content: [toolRequest('call_2', 'edit', { path: 'src/router.ts', before: 'a', after: 'b' })], at: 1_800_000_020 },
  { role: 'user', content: [{ type: 'toolResponse', id: 'call_2', toolResult: { status: 'error', error: 'no match' } }], at: 1_800_000_021 },
  { role: 'assistant', content: [text('Summary kept for the model.')], at: 1_800_000_030, metadata: { userVisible: false, agentVisible: true } },
  { role: 'assistant', content: [toolRequest('call_3', 'shell', { command: 'npm test' })], at: 1_800_000_040 },
  { role: 'user', content: [toolResponse('call_3', 'all tests passed')], at: 1_800_000_041 },
  { role: 'assistant', content: [text('Fixed.')], at: 1_800_000_050 },
];

beforeEach(() => {
  rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'goose-store-'));
  dbPath = path.join(rootDirectory, 'data', 'sessions', 'sessions.db');
});

afterEach(() => {
  setParseWindowBytesForTests();
  fs.rmSync(rootDirectory, { recursive: true, force: true });
});

describe('gooseDataDirectory', () => {
  it('uses GOOSE_PATH_ROOT/data when the root is absolute', () => {
    expect(gooseDataDirectory({ GOOSE_PATH_ROOT: '/opt/goose' }, 'linux', '/home/dev')).toBe('/opt/goose/data');
  });

  it('ignores a relative GOOSE_PATH_ROOT, as Goose does', () => {
    expect(gooseDataDirectory({ GOOSE_PATH_ROOT: 'relative' }, 'linux', '/home/dev')).toBe('/home/dev/.local/share/goose');
  });

  it('follows XDG_DATA_HOME on Linux and macOS, else ~/.local/share', () => {
    expect(gooseDataDirectory({ XDG_DATA_HOME: '/data' }, 'darwin', '/Users/dev')).toBe('/data/goose');
    expect(gooseDataDirectory({}, 'darwin', '/Users/dev')).toBe('/Users/dev/.local/share/goose');
  });

  it('uses %APPDATA%\\Block\\goose\\data on Windows', () => {
    expect(gooseDataDirectory({ APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, 'win32', 'C:\\Users\\dev'))
      .toBe('C:\\Users\\dev\\AppData\\Roaming\\Block\\goose\\data');
    expect(gooseDataDirectory({}, 'win32', 'C:\\Users\\dev')).toBe('C:\\Users\\dev\\AppData\\Roaming\\Block\\goose\\data');
  });
});

describe('mapGooseRows', () => {
  function row(id: number, role: string, content: object[], at: number, metadata?: object): GooseMessageRow {
    return { id, role, content_json: JSON.stringify(content), created_timestamp: at, metadata_json: metadata ? JSON.stringify(metadata) : null };
  }

  it('maps user text, assistant thinking, text and tool calls, and their results', () => {
    const entries = mapGooseRows([
      row(1, 'user', [text('Fix it')], 1_800_000_000),
      row(2, 'assistant', [{ type: 'thinking', thinking: 'Hmm.' }, text('On it.'), toolRequest('c1', 'shell', { command: 'ls' })], 1_800_000_001),
      row(3, 'user', [toolResponse('c1', 'a.txt')], 1_800_000_002),
    ], { model: 'gpt-4o' });
    expect(entries).toEqual([
      { kind: 'user', uuid: 'goose:1', ts: 1_800_000_000_000, text: 'Fix it' },
      {
        kind: 'assistant',
        uuid: 'goose:2',
        ts: 1_800_000_001_000,
        model: 'gpt-4o',
        blocks: [
          { type: 'thinking', text: 'Hmm.' },
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 'c1', name: 'shell', input: { command: 'ls' } },
        ],
      },
      { kind: 'tool_result', uuid: 'goose:3:c1', ts: 1_800_000_002_000, toolUseId: 'c1', content: 'a.txt', isError: false },
    ]);
  });

  it('marks a failed call and a response the tool flagged as an error', () => {
    const entries = mapGooseRows([
      row(1, 'user', [{ type: 'toolResponse', id: 'c1', toolResult: { status: 'error', error: 'denied' } }, toolResponse('c2', 'boom', true)], 1),
    ]);
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'tool_result', toolUseId: 'c1', content: 'denied', isError: true }),
      expect.objectContaining({ kind: 'tool_result', toolUseId: 'c2', content: 'boom', isError: true }),
    ]);
  });

  it('skips a message Goose keeps for the model only, and blocks the viewer has no row for', () => {
    expect(mapGooseRows([
      row(1, 'assistant', [text('hidden summary')], 1, { userVisible: false }),
      row(2, 'assistant', [{ type: 'image', data: 'x', mimeType: 'image/png' }], 2),
      row(3, 'user', [text('   ')], 3),
    ])).toEqual([]);
  });

  it('reads a millisecond timestamp as milliseconds', () => {
    expect(mapGooseRows([row(1, 'user', [text('hi')], 1_800_000_000_123)])[0].ts).toBe(1_800_000_000_123);
  });

  it('skips unparseable content rather than throwing', () => {
    expect(mapGooseRows([{ id: 1, role: 'user', content_json: '{not json', created_timestamp: 1 }])).toEqual([]);
  });
});

describe('the session row', () => {
  it('finds the session by the name Kangentic passed, and by Goose\'s own id', () => {
    createDatabase(CONVERSATION);
    expect(readGooseSession(dbPath, NAME)?.id).toBe(GOOSE_ID);
    expect(readGooseSession(dbPath, GOOSE_ID)?.name).toBe(NAME);
    expect(readGooseSession(dbPath, 'missing')).toBeNull();
  });

  it('answers null for a missing database, never a throw', () => {
    expect(readGooseSession(path.join(rootDirectory, 'nope.db'), NAME)).toBeNull();
  });

  it('reads a database whose sessions table lacks the newer columns', () => {
    const DatabaseConstructor = loadBetterSqlite3();
    if (!DatabaseConstructor) throw new Error('better-sqlite3 failed to load');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const database = new DatabaseConstructor(dbPath);
    database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, created_at TIMESTAMP)');
    database.prepare('INSERT INTO sessions (id, name, created_at) VALUES (?, ?, ?)').run(GOOSE_ID, NAME, '2026-11-03');
    database.close();
    const row = withGooseDatabase(dbPath, null, (open) => findGooseSession(open, NAME));
    expect(row).toMatchObject({ id: GOOSE_ID, modelName: null, totalTokens: null });
  });

  it('gives the live model, context against the configured limit, tokens and cost', () => {
    createDatabase(CONVERSATION);
    const usage = gooseSessionUsage(readGooseSession(dbPath, NAME) as GooseSessionRow);
    expect(usage).toEqual({
      contextWindow: {
        usedPercentage: (12000 / 128000) * 100,
        usedTokens: 12000,
        cacheTokens: 4000,
        totalInputTokens: 30000,
        totalOutputTokens: 2500,
        contextWindowSize: 128000,
      },
      cost: { totalCostUsd: 0.42, totalDurationMs: 0 },
      model: { id: 'gpt-4o', displayName: 'gpt-4o', reportedByAgent: true },
    });
  });

  it('reports an unknown context size as 0 rather than guessing a limit', () => {
    createDatabase(CONVERSATION, { model_config_json: JSON.stringify({ model_name: 'llama3.2' }) });
    const usage = gooseSessionUsage(readGooseSession(dbPath, NAME) as GooseSessionRow);
    expect(usage?.contextWindow).toMatchObject({ contextWindowSize: 0, usedPercentage: 0, usedTokens: 12000 });
  });

  it('reports nothing for a session that has run no turn yet', () => {
    createDatabase([], {
      total_tokens: null, input_tokens: null, output_tokens: null, cache_read_tokens: null,
      accumulated_input_tokens: null, accumulated_output_tokens: null, accumulated_cost: null, model_config_json: null,
    });
    expect(gooseSessionUsage(readGooseSession(dbPath, NAME) as GooseSessionRow)).toBeNull();
  });
});

describe('gooseSessionUsage edge cases', () => {
  function usageRow(overrides: Partial<GooseSessionRow>): GooseSessionRow {
    return {
      id: GOOSE_ID, name: NAME, workingDirectory: null,
      totalTokens: null, inputTokens: null, outputTokens: null, cacheReadTokens: null,
      accumulatedInputTokens: null, accumulatedOutputTokens: null, accumulatedCost: null,
      modelName: null, contextLimit: null,
      ...overrides,
    };
  }

  it('clamps the used percentage to 100 when the tokens pass the context limit', () => {
    const usage = gooseSessionUsage(usageRow({ totalTokens: 200000, contextLimit: 128000 }));
    expect(usage?.contextWindow?.usedPercentage).toBe(100);
    expect(usage?.contextWindow?.usedTokens).toBe(200000);
  });

  it('reports only the cost for a row with only an accumulated cost', () => {
    expect(gooseSessionUsage(usageRow({ accumulatedCost: 0.5 }))).toEqual({ cost: { totalCostUsd: 0.5, totalDurationMs: 0 } });
  });

  it('reports only the model for a row with only a model', () => {
    expect(gooseSessionUsage(usageRow({ modelName: 'gpt-4o' })))
      .toEqual({ model: { id: 'gpt-4o', displayName: 'gpt-4o', reportedByAgent: true } });
  });
});

describe('the database stamp', () => {
  it('moves on a write that lands only in the WAL, before any checkpoint', () => {
    const database = openDatabase();
    database.pragma('journal_mode = WAL');
    database.pragma('wal_autocheckpoint = 0');
    database.exec('CREATE TABLE notes (body TEXT)');
    database.pragma('wal_checkpoint(TRUNCATE)');
    try {
      const before = gooseDatabaseStamp(dbPath);
      const mainFileBefore = fs.statSync(dbPath);
      database.prepare('INSERT INTO notes (body) VALUES (?)').run('x'.repeat(2000));
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
      const mainFileAfter = fs.statSync(dbPath);
      // The main file did not change, so only the WAL entry can move the stamp.
      expect(mainFileAfter.size).toBe(mainFileBefore.size);
      expect(mainFileAfter.mtimeMs).toBe(mainFileBefore.mtimeMs);
      expect(gooseDatabaseStamp(dbPath)).not.toBe(before);
    } finally {
      database.close();
    }
  });

  it('still answers with the main file alone when no WAL file is present', () => {
    createDatabase(CONVERSATION);
    useRollbackJournal();
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    const stamp = gooseDatabaseStamp(dbPath);
    expect(stamp).toMatch(/^[\d.]+:\d+;$/);
  });

  it('answers null with no database file', () => {
    expect(gooseDatabaseStamp(path.join(rootDirectory, 'nope.db'))).toBeNull();
  });
});

describe('withGooseDatabase', () => {
  it('opens read-only: a write in the callback throws and the fallback is returned', () => {
    createDatabase(CONVERSATION);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = withGooseDatabase(dbPath, 'fallback', (database) => {
        database.prepare('INSERT INTO sessions (id, name, working_dir) VALUES (?, ?, ?)').run('written', 'written', '/projects/x');
        return 'wrote';
      });
      expect(result).toBe('fallback');
      expect(readGooseSession(dbPath, 'written')).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a failed read once per path and message', () => {
    // A fresh path per test, since the logged set is module-level.
    const database = openDatabase();
    database.exec(SESSIONS_TABLE);
    database.prepare('INSERT INTO sessions (id, name, working_dir) VALUES (?, ?, ?)').run(GOOSE_ID, NAME, '/projects/my-app');
    database.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(readGooseTail(dbPath, NAME)).toEqual({ entries: [], totalPosition: 0 });
      expect(readGooseTail(dbPath, NAME)).toEqual({ entries: [], totalPosition: 0 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('messages');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the conversation', () => {
  it('reads the whole session in order, scoped to it, with positions for the viewer', () => {
    createDatabase(CONVERSATION);
    const { entries, totalPosition } = readGooseTail(dbPath, NAME);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user', 'assistant', 'tool_result', 'assistant', 'tool_result', 'assistant', 'tool_result', 'assistant',
    ]);
    // The name Kangentic keeps on its record, not Goose's internal id.
    expect(entries.every((entry) => entry.origin?.conversationId === NAME)).toBe(true);
    expect(totalPosition).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.kind === 'user' && entry.text === 'another session')).toBe(false);
  });

  it('reads nothing for an unknown session or a missing database', () => {
    createDatabase(CONVERSATION);
    expect(readGooseTail(dbPath, 'missing')).toEqual({ entries: [], totalPosition: 0 });
    expect(readGooseTail(path.join(rootDirectory, 'nope.db'), NAME)).toEqual({ entries: [], totalPosition: 0 });
  });

  it('cuts a long session to its tail and pages the rest with the same uuids', () => {
    createDatabase(CONVERSATION);
    const whole = readGooseTail(dbPath, NAME).entries;
    setParseWindowBytesForTests(200);
    const tail = readGooseTail(dbPath, NAME).entries;
    const notice = tail[0];
    expect(notice.kind).toBe('system');
    const earlierHistory = notice.kind === 'system' ? notice.earlierHistory : undefined;
    expect(earlierHistory?.conversationId).toBe(NAME);

    // Page backward from the notice's cursor to the start, then stitch.
    const pages: TranscriptEntry[][] = [];
    let cursor = earlierHistory?.cursor;
    for (let guard = 0; cursor && guard < 20; guard++) {
      const result = readGooseTranscriptPage(dbPath, NAME, { direction: 'before', cursor, maxBytes: 200 });
      if (result.status !== 'ok') throw new Error(`page failed: ${JSON.stringify(result)}`);
      pages.unshift(result.page.entries);
      if (result.page.reachedStart) break;
      cursor = result.page.startCursor;
    }
    const stitched = [...pages.flat(), ...tail.slice(1)];
    expect(stitched.map((entry) => entry.uuid)).toEqual(whole.map((entry) => entry.uuid));
  });

  it('answers reset for a cursor the session does not have, and not_found for an unknown session', () => {
    createDatabase(CONVERSATION);
    expect(readGooseTranscriptPage(dbPath, NAME, { direction: 'before', cursor: 'g:999', maxBytes: 200 })).toEqual({ status: 'reset' });
    expect(readGooseTranscriptPage(dbPath, 'missing', { direction: 'before', cursor: 'g:end', maxBytes: 200 }))
      .toEqual({ status: 'unavailable', reason: 'not_found' });
    expect(readGooseTranscriptPage(path.join(rootDirectory, 'nope.db'), NAME, { direction: 'before', maxBytes: 200 }))
      .toEqual({ status: 'unavailable', reason: 'file_missing' });
  });

  it('answers reset when the source token is another session\'s', () => {
    createDatabase(CONVERSATION);
    expect(readGooseTranscriptPage(dbPath, NAME, { direction: 'after', cursor: 'g:end', maxBytes: 200, sourceToken: 'goose:other:1' }))
      .toEqual({ status: 'reset' });
  });
});

describe('lifetime usage and tool counts', () => {
  it('reads lifetime tokens from the accumulated sums', () => {
    createDatabase(CONVERSATION);
    expect(readGooseTranscriptUsage(dbPath, NAME)).toEqual({ inputTokens: 30000, outputTokens: 2500 });
    expect(readGooseTranscriptUsage(dbPath, 'missing')).toBeNull();
  });

  it('counts distinct calls by tool, with result tokens', () => {
    createDatabase(CONVERSATION);
    expect(readGooseToolCounts(dbPath, NAME)).toEqual({
      toolCallCount: 3,
      toolBreakdown: [
        { toolName: 'shell', callCount: 2, totalDurationMs: 0, interruptedCount: 0, resultTokens: Math.ceil('src/router.ts:12: redirect()'.length / 4) + Math.ceil('all tests passed'.length / 4) },
        { toolName: 'edit', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: Math.ceil('no match'.length / 4) },
      ],
    });
  });

  it('counts only the calls in [sinceMs, untilMs)', () => {
    createDatabase(CONVERSATION);
    const counts = readGooseToolCounts(dbPath, NAME, 1_800_000_020_000, 1_800_000_040_000);
    expect(counts).toEqual({ toolCallCount: 1, toolBreakdown: [expect.objectContaining({ toolName: 'edit', callCount: 1 })] });
    expect(readGooseToolResultTokens(dbPath, NAME, 1_800_000_040_000, null)).toEqual({ shell: Math.ceil('all tests passed'.length / 4) });
  });

  it('answers null with no calls, and an empty object for result tokens it could read', () => {
    createDatabase([{ role: 'user', content: [text('hi')], at: 1 }]);
    expect(readGooseToolCounts(dbPath, NAME)).toBeNull();
    expect(readGooseToolResultTokens(dbPath, NAME)).toEqual({});
    expect(readGooseToolResultTokens(dbPath, 'missing')).toBeNull();
  });
});

/** The bytes of each seeded message's content_json, in order: the position unit. */
function conversationSizes(messages: MessageSeed[]): number[] {
  return messages.map((message) => Buffer.byteLength(JSON.stringify(message.content)));
}

function sumOf(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('paging the conversation', () => {
  // The first of our messages is row 2 (row 1 belongs to another session).
  const FIRST_CURSOR = 'g:2';

  function pageOrThrow(request: Parameters<typeof readGooseTranscriptPage>[2]): Extract<ReturnType<typeof readGooseTranscriptPage>, { status: 'ok' }>['page'] {
    const result = readGooseTranscriptPage(dbPath, NAME, request);
    if (result.status !== 'ok') throw new Error(`page failed: ${JSON.stringify(result)}`);
    return result.page;
  }

  it('pages forward with direction after to the end, in whole-conversation order', () => {
    createDatabase(CONVERSATION);
    const whole = readGooseTail(dbPath, NAME).entries;
    const pages: TranscriptEntry[][] = [];
    let cursor = FIRST_CURSOR;
    let lastPage: ReturnType<typeof pageOrThrow> | undefined;
    for (let guard = 0; guard < 20; guard++) {
      lastPage = pageOrThrow({ direction: 'after', cursor, maxBytes: 200 });
      pages.push(lastPage.entries);
      if (lastPage.reachedEnd) break;
      cursor = lastPage.endCursor;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat().map((entry) => entry.uuid)).toEqual(whole.map((entry) => entry.uuid));
    expect(lastPage?.reachedEnd).toBe(true);
    expect(lastPage?.endCursor).toBe('g:end');
  });

  it('centres a request with only a position on the message that spans it', () => {
    createDatabase(CONVERSATION);
    const sizes = conversationSizes(CONVERSATION);
    // One byte into the fourth message (row 5), sized to hold exactly that message.
    const position = sumOf(sizes.slice(0, 3)) + 1;
    const page = pageOrThrow({ position, maxBytes: sizes[3] });
    expect(page.entries.map((entry) => entry.uuid)).toEqual(['goose:5']);
    expect(page.startPosition).toBeLessThanOrEqual(position);
    expect(page.endPosition).toBeGreaterThan(position);
    expect(page.reachedStart).toBe(false);
    expect(page.reachedEnd).toBe(false);
  });

  it('stops before untilPosition, keeping every entry\'s start under it, and reports the end', () => {
    createDatabase(CONVERSATION);
    const sizes = conversationSizes(CONVERSATION);
    const untilPosition = sumOf(sizes.slice(0, 4));
    const page = pageOrThrow({ direction: 'after', cursor: FIRST_CURSOR, maxBytes: 1_000_000, untilPosition });
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.length).toBeLessThan(readGooseTail(dbPath, NAME).entries.length);
    for (const entry of page.entries) {
      expect(entry.origin?.position).toBeLessThan(untilPosition);
    }
    expect(page.reachedEnd).toBe(true);
    expect(page.endCursor).toBe('g:6');
  });

  it('returns a message larger than maxBytes as a page of its own', () => {
    createDatabase(CONVERSATION);
    const forward = pageOrThrow({ direction: 'after', cursor: FIRST_CURSOR, maxBytes: 1 });
    expect(forward.entries.map((entry) => entry.uuid)).toEqual(['goose:2']);
    const backward = pageOrThrow({ direction: 'before', cursor: 'g:end', maxBytes: 1 });
    expect(backward.entries.map((entry) => entry.uuid)).toEqual(['goose:10']);
  });
});

describe('positions are bytes of content_json', () => {
  it('sizes a multi-byte message by its bytes, not its characters', () => {
    const messages: MessageSeed[] = [
      { role: 'user', content: [text('héllo wörld')], at: 1_800_000_000 },
      { role: 'assistant', content: [text('日本語のテキスト')], at: 1_800_000_001 },
    ];
    createDatabase(messages);
    const serialized = messages.map((message) => JSON.stringify(message.content));
    const expectedBytes = sumOf(serialized.map((value) => Buffer.byteLength(value)));
    expect(expectedBytes).toBeGreaterThan(sumOf(serialized.map((value) => value.length)));
    expect(readGooseTail(dbPath, NAME).totalPosition).toBe(expectedBytes);
  });
});

describe('tool call tallies', () => {
  it('reads a millisecond created_timestamp as milliseconds: inside its window, not outside', () => {
    createDatabase([
      { role: 'assistant', content: [toolRequest('call_ms', 'shell', { command: 'ls' })], at: 1_800_000_010_000 },
      { role: 'user', content: [toolResponse('call_ms', 'a.txt b.txt')], at: 1_800_000_011_000 },
    ]);
    expect(readGooseToolCounts(dbPath, NAME, 1_800_000_000_000, 1_800_000_020_000)).toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'shell', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: Math.ceil('a.txt b.txt'.length / 4) }],
    });
    expect(readGooseToolCounts(dbPath, NAME, 1_800_000_020_000, null)).toBeNull();
    expect(readGooseToolResultTokens(dbPath, NAME, 1_800_000_020_000, null)).toEqual({});
  });

  it('counts a toolRequest id emitted in two rows once', () => {
    createDatabase([
      { role: 'assistant', content: [toolRequest('call_dup', 'shell', { command: 'ls' })], at: 1_800_000_010 },
      { role: 'assistant', content: [toolRequest('call_dup', 'shell', { command: 'ls' })], at: 1_800_000_011 },
    ]);
    expect(readGooseToolCounts(dbPath, NAME)).toEqual({
      toolCallCount: 1,
      toolBreakdown: [expect.objectContaining({ toolName: 'shell', callCount: 1 })],
    });
  });

  it('counts the result tokens of a response in the window under a request from before it, without counting the request', () => {
    createDatabase([
      { role: 'assistant', content: [toolRequest('call_old', 'shell', { command: 'ls' })], at: 1_800_000_010 },
      { role: 'user', content: [toolResponse('call_old', 'late output')], at: 1_800_000_050 },
      { role: 'assistant', content: [toolRequest('call_new', 'edit', { path: 'a.ts' })], at: 1_800_000_060 },
      { role: 'user', content: [toolResponse('call_new', 'edited')], at: 1_800_000_061 },
    ]);
    const sinceMs = 1_800_000_040_000;
    expect(readGooseToolCounts(dbPath, NAME, sinceMs, null)).toEqual({
      toolCallCount: 1,
      toolBreakdown: [expect.objectContaining({ toolName: 'edit', callCount: 1 })],
    });
    expect(readGooseToolResultTokens(dbPath, NAME, sinceMs, null)).toEqual({
      shell: Math.ceil('late output'.length / 4),
      edit: Math.ceil('edited'.length / 4),
    });
  });

  it('counts a call whose response lands at untilMs, with no result tokens from that response', () => {
    createDatabase([
      { role: 'assistant', content: [toolRequest('call_edge', 'shell', { command: 'ls' })], at: 1_800_000_010 },
      { role: 'user', content: [toolResponse('call_edge', 'output')], at: 1_800_000_040 },
    ]);
    const untilMs = 1_800_000_040_000;
    const counts = readGooseToolCounts(dbPath, NAME, 1_800_000_000_000, untilMs);
    expect(counts?.toolCallCount).toBe(1);
    expect(counts?.toolBreakdown).toEqual([{ toolName: 'shell', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }]);
    expect(readGooseToolResultTokens(dbPath, NAME, 1_800_000_000_000, untilMs)).toEqual({});
  });
});

describe('a sessions table with no created_at column', () => {
  it('still finds the row, since the lookup asks for no order', () => {
    const database = openDatabase();
    database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER)');
    database.prepare('INSERT INTO sessions (id, name, total_tokens, accumulated_input_tokens, accumulated_output_tokens) VALUES (?, ?, ?, ?, ?)')
      .run(GOOSE_ID, NAME, 500, 400, 100);
    database.close();
    expect(withGooseDatabase(dbPath, null, (open) => findGooseSession(open, NAME))).toMatchObject({ id: GOOSE_ID, totalTokens: 500 });
    expect(readGooseSession(dbPath, GOOSE_ID)).toMatchObject({ name: NAME, accumulatedInputTokens: 400, accumulatedOutputTokens: 100 });
  });
});

describe('GooseAdapter over the session store', () => {
  const previousRoot = process.env.GOOSE_PATH_ROOT;

  beforeEach(() => {
    process.env.GOOSE_PATH_ROOT = rootDirectory;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.GOOSE_PATH_ROOT;
    else process.env.GOOSE_PATH_ROOT = previousRoot;
  });

  it('parses the transcript from Goose\'s database, and none for a distro Goose', async () => {
    createDatabase(CONVERSATION);
    const adapter = new GooseAdapter();
    const parsed = await adapter.parseTranscript(NAME, '/projects/my-app');
    expect(parsed.sourcePath).toBe(dbPath);
    expect(parsed.entries.length).toBe(8);
    const place = { distro: 'Ubuntu' } as Parameters<typeof adapter.parseTranscript>[2];
    expect(await adapter.parseTranscript(NAME, '/projects/my-app', place)).toEqual({ entries: [], sourcePath: null });
    expect(await adapter.transcriptUsage({ agentSessionId: NAME, place })).toBeNull();
  });

  it('applies the session row\'s usage as soon as it attaches, then stops on dispose', () => {
    createDatabase(CONVERSATION);
    const adapter = new GooseAdapter();
    adapter.buildCommand({ agentPath: '/usr/bin/goose', taskId: 't', cwd: rootDirectory, permissionMode: 'default', ptySessionId: 'pty-1', sessionId: NAME });
    const applied: Array<Partial<SessionUsage>> = [];
    const attachment = adapter.attachSession({ sessionId: 'pty-1', applyUsage: (usage) => applied.push(usage) });
    expect(applied).toHaveLength(1);
    expect(applied[0].model).toEqual({ id: 'gpt-4o', displayName: 'gpt-4o', reportedByAgent: true });
    expect(applied[0].contextWindow?.contextWindowSize).toBe(128000);
    attachment.dispose();
  });

  it('reports the transcript position as the byte sum of the session\'s content_json values', async () => {
    createDatabase(CONVERSATION);
    const parsed = await new GooseAdapter().parseTranscript(NAME, '/projects/my-app');
    expect(parsed.totalPosition).toBe(sumOf(conversationSizes(CONVERSATION)));
  });

  it('forwards sinceMs and untilMs to the tool readers, so a call before sinceMs is not counted', async () => {
    createDatabase(CONVERSATION);
    const adapter = new GooseAdapter();
    const counts = await adapter.transcriptToolCounts({ agentSessionId: NAME, sinceMs: 1_800_000_020_000, untilMs: 1_800_000_040_000 });
    expect(counts).toEqual({ toolCallCount: 1, toolBreakdown: [expect.objectContaining({ toolName: 'edit', callCount: 1 })] });
    expect(await adapter.transcriptToolResultTokens({ agentSessionId: NAME, sinceMs: 1_800_000_040_000, untilMs: null }))
      .toEqual({ shell: Math.ceil('all tests passed'.length / 4) });
    // Unscoped, the same session counts all three calls.
    expect((await adapter.transcriptToolCounts({ agentSessionId: NAME }))?.toolCallCount).toBe(3);
  });

  it('keeps no launch record after dispose, so a second attach for the same session polls nothing', () => {
    createDatabase(CONVERSATION);
    const adapter = new GooseAdapter();
    adapter.buildCommand({ agentPath: '/usr/bin/goose', taskId: 't', cwd: rootDirectory, permissionMode: 'default', ptySessionId: 'pty-1', sessionId: NAME });
    const first: Array<Partial<SessionUsage>> = [];
    adapter.attachSession({ sessionId: 'pty-1', applyUsage: (usage) => first.push(usage) }).dispose();
    expect(first).toHaveLength(1);

    const second: Array<Partial<SessionUsage>> = [];
    adapter.attachSession({ sessionId: 'pty-1', applyUsage: (usage) => second.push(usage) }).dispose();
    expect(second).toEqual([]);
  });

  it('keeps no launch record after a distro launch\'s dispose either', () => {
    const adapter = new GooseAdapter();
    adapter.buildCommand({
      agentPath: '/usr/bin/goose', taskId: 't', cwd: rootDirectory, permissionMode: 'default', ptySessionId: 'pty-wsl', sessionId: NAME,
      cliTarget: { distro: 'Ubuntu', linuxCliPath: '/usr/bin/goose' } as Parameters<GooseAdapter['buildCommand']>[0]['cliTarget'],
    });
    // The launch table is private and the early return gives nothing else to observe.
    const launches = (adapter as unknown as { sessionLaunches: Map<string, unknown> }).sessionLaunches;
    expect(launches.has('pty-wsl')).toBe(true);
    adapter.attachSession({ sessionId: 'pty-wsl', applyUsage: () => undefined }).dispose();
    expect(launches.has('pty-wsl')).toBe(false);
  });

  it('polls nothing for a session it never saw launched', () => {
    createDatabase(CONVERSATION);
    const adapter = new GooseAdapter();
    const applied: Array<Partial<SessionUsage>> = [];
    adapter.attachSession({ sessionId: 'unknown', applyUsage: (usage) => applied.push(usage) }).dispose();
    expect(applied).toEqual([]);
  });

  describe('the usage poll', () => {
    const POLL_MS = 3000;

    function attach(options: { cliTarget?: Parameters<InstanceType<typeof GooseAdapter>['buildCommand']>[0]['cliTarget'] } = {}): {
      applied: Array<Partial<SessionUsage>>;
      dispose: () => void;
    } {
      const adapter = new GooseAdapter();
      adapter.buildCommand({
        agentPath: '/usr/bin/goose', taskId: 't', cwd: rootDirectory, permissionMode: 'default',
        ptySessionId: 'pty-1', sessionId: NAME, ...options,
      });
      const applied: Array<Partial<SessionUsage>> = [];
      const attachment = adapter.attachSession({ sessionId: 'pty-1', applyUsage: (usage) => applied.push(usage) });
      return { applied, dispose: () => attachment.dispose() };
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reads again only when the database stamp moves, and applies only a changed usage', () => {
      createDatabase(CONVERSATION);
      useRollbackJournal();
      setDatabaseMtime(1);
      const { applied, dispose } = attach();
      expect(applied).toHaveLength(1);

      // Untouched: nothing new.
      vi.advanceTimersByTime(POLL_MS * 2);
      expect(applied).toHaveLength(1);

      // The row changes but the stamp does not (same size, same mtime): the poll
      // does not read it, so nothing is applied.
      updateTotalTokens(13000);
      setDatabaseMtime(1);
      vi.advanceTimersByTime(POLL_MS);
      expect(applied).toHaveLength(1);

      // The stamp moves: the changed usage is applied once.
      setDatabaseMtime(2);
      vi.advanceTimersByTime(POLL_MS);
      expect(applied).toHaveLength(2);
      expect(applied[1].contextWindow?.usedTokens).toBe(13000);

      // A rewrite that moves the stamp but not the usage applies nothing.
      setDatabaseMtime(3);
      vi.advanceTimersByTime(POLL_MS);
      expect(applied).toHaveLength(2);
      dispose();
    });

    it('applies nothing after dispose', () => {
      createDatabase(CONVERSATION);
      useRollbackJournal();
      setDatabaseMtime(1);
      const { applied, dispose } = attach();
      dispose();
      updateTotalTokens(14000);
      setDatabaseMtime(2);
      vi.advanceTimersByTime(POLL_MS * 2);
      expect(applied).toHaveLength(1);
    });

    it('applies a session row written after attach, even when the stamp does not move again', () => {
      createEmptyDatabase();
      useRollbackJournal();
      setDatabaseMtime(1);
      const { applied, dispose } = attach();
      expect(applied).toHaveLength(0);

      // Same size and mtime as when the empty database was first stamped.
      insertSessionRow(12000);
      setDatabaseMtime(1);
      vi.advanceTimersByTime(POLL_MS);
      expect(applied).toHaveLength(1);
      expect(applied[0].contextWindow?.usedTokens).toBe(12000);
      dispose();
    });

    it('attaches and applies nothing for a launch in a WSL distro', () => {
      createDatabase(CONVERSATION);
      const { applied, dispose } = attach({ cliTarget: { distro: 'Ubuntu', linuxCliPath: '/usr/bin/goose' } as Parameters<InstanceType<typeof GooseAdapter>['buildCommand']>[0]['cliTarget'] });
      vi.advanceTimersByTime(POLL_MS * 2);
      expect(applied).toEqual([]);
      dispose();
    });
  });
});
