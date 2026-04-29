/**
 * Schema canary unit tests for OpenCodeSessionHistoryParser.
 *
 * Validates `verifyOpenCodeSchemaOnce` against synthetic SQLite DBs:
 *  - present-and-correct: no warning fires
 *  - missing column: exactly one warning fires, names the column
 *  - missing table: warning fires, names the table
 *  - once-per-process: a second call against the same broken schema does NOT re-warn
 *
 * Also covers the indirect path:
 *  - captureSessionIdFromFilesystem -> readMatchingSessionId ->
 *    verifyOpenCodeSchemaOnce(db, getAgentVersion) with a broken synthetic DB
 *    planted at the mocked homedir location, confirming the getAgentVersion
 *    argument is threaded all the way through.
 *
 * Skips cleanly when better-sqlite3 cannot load (NODE_MODULE_VERSION
 * mismatch under raw Node), mirroring the live-DB test's pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __resetSchemaCanaryForTests,
  verifyOpenCodeSchemaOnce,
  OpenCodeSessionHistoryParser,
} from '../../src/main/agent/adapters/opencode/session-history-parser';

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    const moduleName = 'better-sqlite3';
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = ((nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule) as typeof DatabaseType;
    // Force the native binding to load now (NODE_MODULE_VERSION
    // mismatch only surfaces on instantiation, not on require). An
    // in-memory `:memory:` DB needs no filesystem cleanup.
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

function makeTempDbPath(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `opencode-canary-${label}-`));
  return path.join(directory, 'opencode.db');
}

function createDbWithSchema(createTableStatement: string | null): { path: string; cleanup: () => void } {
  if (!Database) throw new Error('better-sqlite3 not available');
  const dbPath = makeTempDbPath('test');
  const database = new Database(dbPath);
  if (createTableStatement) database.exec(createTableStatement);
  database.close();
  return {
    path: dbPath,
    cleanup: () => {
      try {
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe.runIf(CAN_RUN)('verifyOpenCodeSchemaOnce', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    __resetSchemaCanaryForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup?.();
    }
  });

  it('does not warn when all required columns are present', () => {
    if (!Database) return;
    const fixture = createDbWithSchema(
      `CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )`,
    );
    cleanups.push(fixture.cleanup);
    const database = new Database(fixture.path, { readonly: true, fileMustExist: true });
    try {
      verifyOpenCodeSchemaOnce(database, () => '1.14.25');
    } finally {
      database.close();
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once when a required column is missing, naming the column and version', () => {
    if (!Database) return;
    const fixture = createDbWithSchema(
      `CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL
      )`,
    );
    cleanups.push(fixture.cleanup);
    const database = new Database(fixture.path, { readonly: true, fileMustExist: true });
    try {
      verifyOpenCodeSchemaOnce(database, () => '1.99.0');
    } finally {
      database.close();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0];
    expect(message).toContain('time_created');
    expect(message).toContain('1.99.0');
    expect(message).toContain('opencode.db schema mismatch');
  });

  it('warns once when the session table is missing entirely', () => {
    if (!Database) return;
    const fixture = createDbWithSchema(null);
    cleanups.push(fixture.cleanup);
    const database = new Database(fixture.path, { readonly: true, fileMustExist: true });
    try {
      verifyOpenCodeSchemaOnce(database, () => '2.0.0');
    } finally {
      database.close();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0];
    expect(message).toContain('`session` table is missing');
    expect(message).toContain('2.0.0');
  });

  it('does not re-warn on subsequent calls within the same process lifetime', () => {
    if (!Database) return;
    const fixture = createDbWithSchema(
      `CREATE TABLE session (id TEXT PRIMARY KEY)`,
    );
    cleanups.push(fixture.cleanup);
    const database = new Database(fixture.path, { readonly: true, fileMustExist: true });
    try {
      verifyOpenCodeSchemaOnce(database);
      verifyOpenCodeSchemaOnce(database);
      verifyOpenCodeSchemaOnce(database);
    } finally {
      database.close();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('omits the version suffix when getAgentVersion is not provided', () => {
    if (!Database) return;
    const fixture = createDbWithSchema(
      `CREATE TABLE session (id TEXT PRIMARY KEY)`,
    );
    cleanups.push(fixture.cleanup);
    const database = new Database(fixture.path, { readonly: true, fileMustExist: true });
    try {
      verifyOpenCodeSchemaOnce(database);
    } finally {
      database.close();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0];
    expect(message).not.toContain('detected version:');
  });

  it('omits the version suffix when getAgentVersion returns null', () => {
    if (!Database) return;
    const fixture = createDbWithSchema(
      `CREATE TABLE session (id TEXT PRIMARY KEY)`,
    );
    cleanups.push(fixture.cleanup);
    const database = new Database(fixture.path, { readonly: true, fileMustExist: true });
    try {
      verifyOpenCodeSchemaOnce(database, () => null);
    } finally {
      database.close();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0];
    expect(message).not.toContain('detected version:');
  });
});

/**
 * Gap A: indirect path through captureSessionIdFromFilesystem.
 *
 * Plants a synthetic broken-schema DB at the path that openCodeDbPath()
 * resolves to (by mocking os.homedir()), then calls the public static
 * method with a non-null getAgentVersion callback. Verifies that the
 * canary warning includes the version string returned by the callback -
 * proving the argument is threaded through readMatchingSessionId all the
 * way into verifyOpenCodeSchemaOnce.
 *
 * A refactor that drops the getAgentVersion parameter from the internal
 * readMatchingSessionId(…) call would cause the warning to omit the
 * version suffix and break these assertions.
 */
describe.runIf(CAN_RUN)('captureSessionIdFromFilesystem - schema canary indirect path', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let fakeTmpDir: string;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    __resetSchemaCanaryForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create a tempdir that will masquerade as the home directory.
    // openCodeDbPath() returns path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
    // so we plant the DB at that relative location inside the temp dir.
    fakeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-indirect-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeTmpDir);
    cleanups.push(() => {
      try {
        fs.rmSync(fakeTmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    warnSpy.mockRestore();
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup?.();
    }
  });

  it('threads getAgentVersion through to verifyOpenCodeSchemaOnce when a column is missing', async () => {
    if (!Database) return;

    // Plant a broken DB - missing the required time_created column.
    const opencodeDir = path.join(fakeTmpDir, '.local', 'share', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const dbPath = path.join(opencodeDir, 'opencode.db');
    const brokenDb = new Database(dbPath);
    brokenDb.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)`);
    brokenDb.close();

    // Call captureSessionIdFromFilesystem with a non-null getAgentVersion.
    // maxAttempts: 1 so the test doesn't spin for 10 seconds.
    // The function will return null (schema is broken so the SELECT will
    // fail on the missing time_created column), but the canary MUST warn
    // before that happens.
    const getVersionCallback = vi.fn(() => '9.9.9');
    const result = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(),
      cwd: '/some/project/path',
      maxAttempts: 1,
      getAgentVersion: getVersionCallback,
    });

    expect(result).toBeNull();
    // The canary must have fired exactly once.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warningMessage = warnSpy.mock.calls[0]?.[0];
    // Must name the missing column.
    expect(warningMessage).toContain('time_created');
    // Must include the version string from the callback.
    expect(warningMessage).toContain('9.9.9');
    expect(warningMessage).toContain('opencode.db schema mismatch');
  });

  it('threads getAgentVersion through to verifyOpenCodeSchemaOnce when the table is missing', async () => {
    if (!Database) return;

    // Plant an empty DB (no tables at all).
    const opencodeDir = path.join(fakeTmpDir, '.local', 'share', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const dbPath = path.join(opencodeDir, 'opencode.db');
    const emptyDb = new Database(dbPath);
    emptyDb.close();

    const getVersionCallback = vi.fn(() => '10.0.0-beta');
    const result = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(),
      cwd: '/some/project/path',
      maxAttempts: 1,
      getAgentVersion: getVersionCallback,
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warningMessage = warnSpy.mock.calls[0]?.[0];
    expect(warningMessage).toContain('`session` table is missing');
    expect(warningMessage).toContain('10.0.0-beta');
  });

  it('fires no warning when the schema is correct and no row matches', async () => {
    if (!Database) return;

    // Plant a well-formed DB with the correct schema but no rows.
    const opencodeDir = path.join(fakeTmpDir, '.local', 'share', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const dbPath = path.join(opencodeDir, 'opencode.db');
    const goodDb = new Database(dbPath);
    goodDb.exec(
      `CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )`,
    );
    goodDb.close();

    const getVersionCallback = vi.fn(() => '1.14.25');
    const result = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(),
      cwd: '/some/project/path',
      maxAttempts: 1,
      getAgentVersion: getVersionCallback,
    });

    expect(result).toBeNull();
    // No schema problems -> no canary warning.
    const opencodeWarnings = warnSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === 'string' && first.includes('[opencode]');
    });
    expect(opencodeWarnings).toEqual([]);
  });
});

describe.runIf(!CAN_RUN)('verifyOpenCodeSchemaOnce (skipped)', () => {
  it('skipped because better-sqlite3 cannot load under this Node runtime', () => {
    expect(CAN_RUN).toBe(false);
  });
});
