/**
 * Pins the SQL query SHAPE behind OpenCode's `command-injection` verifier
 * (the private `queryForSubmittedText` in
 * `src/main/agent/adapters/opencode/command-injection-verifier.ts`), which the
 * pure row-mapper tests in `confirm-only-command-injection-verifiers.test.ts`
 * do not reach - those only exercise `findOpenCodeSubmittedText`, the function
 * `queryForSubmittedText` calls AFTER its two queries already ran.
 *
 * Regression this guards (fixed in ca8324f5, "fix(review): bound the OpenCode
 * part scan and pin the confirm-only escalation gate"): the `part` query was
 * copy-pasted from `transcript-parser.ts`'s one-shot transcript read,
 * `SELECT message_id, data FROM part WHERE session_id = ?` with no
 * `message_id` bound. `part` holds one row per streamed chunk for EVERY
 * message in the session, so that query scanned and JSON-parsed the whole
 * conversation's parts on every 25ms poll, synchronously via better-sqlite3,
 * on the thread that services IPC - a cost that grows with session length. The
 * fix scopes the query to `message_id IN (...)` over the message rows already
 * fetched by the first query.
 *
 * `queryForSubmittedText` is not exported and opens its own better-sqlite3
 * handle, so this drives it through the public
 * `createOpenCodeCommandInjectionVerifier()` entry point with a mocked
 * `loadBetterSqlite3` that RECORDS every prepared query and its bound params,
 * rather than executing real SQLite. The real native binding cannot load
 * under this Node runtime (NODE_MODULE_VERSION mismatch - see the `CAN_RUN`
 * guard in `opencode-schema-canary.test.ts`), which is also why the OTHER
 * repository unit tests in this codebase (e.g. `task-repository.test.ts`)
 * mock the Database interface instead of running real queries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockLoadBetterSqlite3, mockOpenCodeDbPath } = vi.hoisted(() => ({
  mockLoadBetterSqlite3: vi.fn(),
  mockOpenCodeDbPath: vi.fn(),
}));

vi.mock('../../src/main/agent/adapters/opencode/session-history-parser', () => ({
  loadBetterSqlite3: mockLoadBetterSqlite3,
  openCodeDbPath: mockOpenCodeDbPath,
}));

import { createOpenCodeCommandInjectionVerifier } from '../../src/main/agent/adapters/opencode/command-injection-verifier';

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

interface FakeMessageRow {
  id: string;
  time_created: number;
  data: string;
}

/** Two user messages, standing in for the recent tail of a live session. */
const MESSAGE_ROWS: FakeMessageRow[] = [
  { id: 'msg-recent-1', time_created: 0, data: JSON.stringify({ role: 'user' }) },
  { id: 'msg-recent-2', time_created: 0, data: JSON.stringify({ role: 'user' }) },
];

/**
 * Builds a fake `better-sqlite3` Database constructor that answers `message`
 * and `part` queries with canned rows and appends every `(sql, params)` pair
 * it is asked to run into `recorded` - the thing this test actually inspects.
 * The fake does not itself filter by the bound params; the test asserts the
 * bound was ASKED FOR, which is what the production code is responsible for.
 */
function makeFakeDatabaseConstructor(
  recorded: RecordedQuery[],
  messageRows: FakeMessageRow[],
): new (...args: unknown[]) => unknown {
  return class FakeDatabase {
    prepare(sql: string): { all: (...params: unknown[]) => unknown[] } {
      return {
        all: (...params: unknown[]) => {
          recorded.push({ sql, params });
          if (/FROM message/.test(sql)) return messageRows;
          if (/FROM part/.test(sql)) {
            return [
              { message_id: 'msg-recent-1', data: JSON.stringify({ type: 'text', text: '/pull-request' }) },
              { message_id: 'msg-recent-2', data: JSON.stringify({ type: 'text', text: 'unrelated' }) },
            ];
          }
          return [];
        },
      };
    }
    close(): void {
      // no-op
    }
  } as unknown as new (...args: unknown[]) => unknown;
}

let tmpDir: string;
let dbPath: string;
let recorded: RecordedQuery[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-query-'));
  dbPath = path.join(tmpDir, 'opencode.db');
  // createOpenCodeCommandInjectionVerifier only gates on fs.existsSync before
  // opening the (mocked) DB, so an empty placeholder file is enough.
  fs.writeFileSync(dbPath, '');
  recorded = [];
  mockOpenCodeDbPath.mockReturnValue(dbPath);
  mockLoadBetterSqlite3.mockReturnValue(makeFakeDatabaseConstructor(recorded, MESSAGE_ROWS));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('OpenCode command-injection verifier - part query bound', () => {
  it('scopes the part query to the message ids the message query just fetched, not the whole session', async () => {
    const verifier = createOpenCodeCommandInjectionVerifier();
    await verifier({
      type: 'command-injection',
      text: '/pull-request',
      agentSessionId: 'session-1',
      sentAt: Date.now(),
    });

    const partQuery = recorded.find((entry) => /FROM part/.test(entry.sql));
    expect(partQuery).toBeDefined();

    // WHERE session_id = ? AND message_id IN (?, ?): everything past the
    // leading session id must be EXACTLY the message ids just fetched, never
    // a bare session-wide scan (`WHERE session_id = ?` alone, which is the
    // pre-fix shape this test would have let through).
    const [sessionIdParam, ...messageIdParams] = partQuery!.params;
    expect(sessionIdParam).toBe('session-1');
    expect(messageIdParams).toEqual(['msg-recent-1', 'msg-recent-2']);
    expect(partQuery!.sql).toMatch(/message_id\s+IN\s*\(/i);
  });

  it('never runs the part query when no messages matched (early exit, nothing to bound to)', async () => {
    mockLoadBetterSqlite3.mockReturnValue(makeFakeDatabaseConstructor(recorded, []));

    const verifier = createOpenCodeCommandInjectionVerifier();
    const result = await verifier({
      type: 'command-injection',
      text: '/pull-request',
      agentSessionId: 'session-1',
      sentAt: Date.now(),
    });

    expect(result).toBe(false);
    expect(recorded.some((entry) => /FROM part/.test(entry.sql))).toBe(false);
  });
});
