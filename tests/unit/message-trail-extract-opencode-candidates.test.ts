/**
 * Regression test for the OpenCode candidate-selection logic inside
 * extractMessageTrail (tests/captures/helpers/message-trail-extract.ts).
 *
 * openCodeCandidates reads OpenCode's `session` table straight out of SQLite and
 * casts the rows with `as OpenCodeSessionRow[]`, an unchecked cast TypeScript
 * cannot verify at runtime. Two pieces of logic run on those rows before a row
 * becomes a candidate: directory normalization (trailing separator) and a
 * seconds-vs-milliseconds heuristic on `time_created`. This replays a small
 * SQLite fixture built with node:sqlite to drive that real logic, because
 * better-sqlite3 in this repo is rebuilt against Electron's Node ABI and cannot
 * load under plain-node vitest (see scripts/lib/better-sqlite3-node-shim.mjs).
 *
 * loadBetterSqlite3 and openCodeDbPath are mocked at the module boundary
 * (standard vitest module mocking, not an implementation change) so the real
 * openCodeCandidates function reads the fixture database through a tiny
 * node:sqlite adapter that satisfies the subset of the better-sqlite3 API it
 * calls: the constructor, prepare().all(), and close(). parseOpenCodeTranscriptAtPath
 * is mocked to return no entries, which keeps the fixture database down to just
 * the `session` table (no message/part schema needed) and gives a deterministic
 * assertion surface: when no transcript carries the recording's prompt,
 * chooseCandidate's thrown error reports the raw candidate count that
 * openCodeCandidates produced from the SQL row filter, before any prompt
 * matching happens.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractMessageTrail, TranscriptMatchError, type RecordingFacts } from '../captures/helpers/message-trail-extract';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const describeWithSqlite = sqlite ? describe : describe.skip;

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-candidates-'));
const fixtureDatabasePath = path.join(temporaryDirectory, 'opencode.db');

interface PreparedStatement {
  all(...parameters: unknown[]): unknown[];
}

/**
 * The subset of the better-sqlite3 API openCodeCandidates calls
 * (constructor, prepare().all(), close()), backed by node:sqlite.
 */
class NodeSqliteAdapter {
  private readonly database: InstanceType<SqliteModule['DatabaseSync']>;

  constructor(filePath: string, options: { readonly?: boolean; fileMustExist?: boolean }) {
    if (options.fileMustExist && !fs.existsSync(filePath)) {
      throw new Error(`fixture database missing: ${filePath}`);
    }
    if (!sqlite) throw new Error('node:sqlite unavailable');
    this.database = new sqlite.DatabaseSync(filePath, { readOnly: options.readonly === true });
  }

  prepare(sql: string): PreparedStatement {
    const statement = this.database.prepare(sql);
    return { all: (...parameters: unknown[]) => statement.all(...parameters) };
  }

  close(): void {
    this.database.close();
  }
}

vi.mock('../../src/main/agent/adapters/opencode/session-history-parser', () => ({
  loadBetterSqlite3: () => NodeSqliteAdapter,
  openCodeDbPath: () => fixtureDatabasePath,
}));

vi.mock('../../src/main/agent/adapters/opencode/transcript-parser', () => ({
  parseOpenCodeTranscriptAtPath: () => [],
}));

describeWithSqlite('extractMessageTrail - OpenCode candidate selection', () => {
  const cwd = '/home/dev/project';
  const capturedAt = '2026-01-01T00:20:00.000Z';
  const durationMs = 10 * 60 * 1000; // 10 minutes
  const startMs = Date.parse(capturedAt) - durationMs;

  beforeAll(() => {
    if (!sqlite) return;
    const writable = new sqlite.DatabaseSync(fixtureDatabasePath);
    writable.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER)');
    const insert = writable.prepare('INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)');
    // Same run as the recording: directory differs only by a trailing separator, and
    // time_created is already milliseconds. Must be counted.
    //
    // Deliberately matched in EXACT case. openCodeCandidates lowercases
    // unconditionally, while the sibling normalizeCwdForCompare in
    // session-history-parser.ts lowercases only on win32, and
    // opencode-session-history-parser.live.test.ts asserts that path stays
    // case-sensitive on POSIX. Pinning the case-folding here would make this test
    // defend that divergence: gating the lowercase on win32 would then fail on Linux
    // while passing on Windows. The trailing separator and the time_created scale are
    // what this row is for, and both hold on every platform.
    insert.run('matches-ms-scale', '/home/dev/project/', startMs);
    // Same run, but time_created was recorded in seconds - must be multiplied by
    // 1000 before it lands within tolerance of startMs. Must be counted.
    insert.run('matches-seconds-scale', cwd, Math.round(startMs / 1000));
    // A different working directory entirely - must be excluded regardless of timing.
    insert.run('wrong-directory', '/home/dev/other-project', startMs);
    // Same directory, but ten million ms outside the tolerance window. Must be excluded.
    insert.run('wrong-time', cwd, startMs + 10_000_000);
    writable.close();
  });

  afterAll(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('normalizes trailing separators and both time_created scales, excluding mismatched rows', async () => {
    const facts: RecordingFacts = {
      agent: 'opencode',
      prompt: 'fix the pagination bug in the checkout flow',
      capturedAt,
      durationMs,
    };

    let thrown: unknown = null;
    try {
      await extractMessageTrail(facts, cwd);
    } catch (error) {
      thrown = error;
    }

    // parseOpenCodeTranscriptAtPath is mocked to return no entries, so every
    // candidate's first-user-text is empty and none can carry the recording's
    // prompt - extractMessageTrail always throws here. What matters is the
    // candidate COUNT the error reports, which is exactly what the SQL row
    // filter in openCodeCandidates produced before prompt matching ever runs.
    expect(thrown).toBeInstanceOf(TranscriptMatchError);
    expect((thrown as Error).message).toContain('(2 candidate(s) read)');
  });
});

describe.runIf(!sqlite)('extractMessageTrail - OpenCode candidate selection (skipped)', () => {
  it('skipped because node:sqlite is unavailable in this runtime', () => {
    // Node 22.5+ ships node:sqlite; this repo runs Node 24 everywhere the
    // unit tier runs, so this branch is not expected to fire. It exists so a
    // silent skip reads as an explicit, asserted skip rather than a quiet
    // pass with zero tests, mirroring opencode-session-history-parser.live.test.ts.
    expect(sqlite).toBeNull();
  });
});
