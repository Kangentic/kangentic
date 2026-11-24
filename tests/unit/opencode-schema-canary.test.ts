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
 * Builds its synthetic DBs with the real better-sqlite3 driver.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __resetSchemaCanaryForTests,
  verifyOpenCodeSchemaOnce,
  OpenCodeSessionHistoryParser,
} from '../../src/main/agent/adapters/opencode/session-history-parser';

function makeTempDbPath(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `opencode-canary-${label}-`));
  return path.join(directory, 'opencode.db');
}

function createDbWithSchema(createTableStatement: string | null): { path: string; cleanup: () => void } {
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

describe('verifyOpenCodeSchemaOnce', () => {
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
describe('captureSessionIdFromFilesystem - schema canary indirect path', () => {
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
    // Plant a broken DB - missing the required time_created column.
    const opencodeDir = path.join(fakeTmpDir, '.local', 'share', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const dbPath = path.join(opencodeDir, 'opencode.db');
    const brokenDb = new Database(dbPath);
    brokenDb.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)`);
    brokenDb.close();

    // Call captureSessionIdFromFilesystem with a non-null getAgentVersion.
    // maxAttempts: 1 so the test doesn't poll to the end of the spawn window.
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

/**
 * OpenCode 2 migrates the same `opencode.db` in place (measured on 2.2.5): it
 * leaves `session` as OpenCode 1 wrote it, copies its rows into `session_v2`,
 * and writes every new session to `session_v2` only, with forward slashes in
 * `directory`. Without reading `session_v2` a V2 spawn's id is never captured,
 * and every resume silently starts a fresh session.
 */
describe('captureSessionIdFromFilesystem - an OpenCode 2 database', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let fakeHome: string;
  let projectDirectory: string;

  const SESSION_TABLE_COLUMNS = `(
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    directory TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`;

  /** A database as OpenCode 2 leaves it: both tables, rows given per table. */
  function plantDatabase(rows: { session?: Array<[string, number]>; sessionV2?: Array<[string, number]> }): void {
    const opencodeDir = path.join(fakeHome, '.local', 'share', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const database = new Database(path.join(opencodeDir, 'opencode.db'));
    database.exec(`CREATE TABLE session ${SESSION_TABLE_COLUMNS}`);
    database.exec(`CREATE TABLE session_v2 ${SESSION_TABLE_COLUMNS}`);
    // OpenCode writes the directory with forward slashes on every platform.
    const directory = projectDirectory.replace(/\\/g, '/');
    for (const [table, tableRows] of [['session', rows.session ?? []], ['session_v2', rows.sessionV2 ?? []]] as const) {
      const insert = database.prepare(`INSERT INTO ${table} (id, project_id, directory, time_created, time_updated) VALUES (?, 'project', ?, ?, ?)`);
      for (const [id, created] of tableRows) insert.run(id, directory, created, created);
    }
    database.close();
  }

  function insertRow(table: 'session' | 'session_v2', id: string, created: number, directory = projectDirectory): void {
    const database = new Database(path.join(fakeHome, '.local', 'share', 'opencode', 'opencode.db'));
    database.prepare(`INSERT INTO ${table} (id, project_id, directory, time_created, time_updated) VALUES (?, 'project', ?, ?, ?)`)
      .run(id, directory.replace(/\\/g, '/'), created, created);
    database.close();
  }

  beforeEach(() => {
    __resetSchemaCanaryForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-db-'));
    projectDirectory = path.join(fakeHome, 'project');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    warnSpy.mockRestore();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('captures a session OpenCode 2 wrote only to session_v2', async () => {
    const spawnedAt = new Date();
    plantDatabase({
      session: [['ses_v1copyOlderThanTheSpawnAAA', spawnedAt.getTime() - 3_600_000]],
      sessionV2: [
        ['ses_v1copyOlderThanTheSpawnAAA', spawnedAt.getTime() - 3_600_000],
        ['ses_e601c5bccffeTD1q4jpiKAT40X', spawnedAt.getTime() + 400],
      ],
    });

    const result = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt, cwd: projectDirectory, maxAttempts: 1 });

    expect(result).toBe('ses_e601c5bccffeTD1q4jpiKAT40X');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still captures an OpenCode 1 session written to session after the migration', async () => {
    const spawnedAt = new Date();
    plantDatabase({ session: [['ses_writtenByOpenCodeOneAfterV2', spawnedAt.getTime() + 300]] });

    const result = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt, cwd: projectDirectory, maxAttempts: 1 });

    expect(result).toBe('ses_writtenByOpenCodeOneAfterV2');
  });

  // The scan accepts a row made up to 30 s after the spawn and used to stop
  // looking at 10 s, so a row made in between was never found (Sentry DESKTOP-3A,
  // fs_scan empty). The fake sleep is the clock: it plants the row when it gets there.
  it('finds a row made 20 s after the spawn', async () => {
    const spawnedAt = new Date();
    plantDatabase({});
    let elapsedMs = 0;
    const sleep = async (milliseconds: number): Promise<void> => {
      const before = elapsedMs;
      elapsedMs += milliseconds;
      if (before < 20_000 && elapsedMs >= 20_000) insertRow('session', 'ses_madeTwentySecondsIn', spawnedAt.getTime() + 20_000);
    };

    const result = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt, cwd: projectDirectory, sleep });

    expect(result).toBe('ses_madeTwentySecondsIn');
  });

  it('looks past the end of its own window, then stops', async () => {
    const spawnedAt = new Date();
    plantDatabase({});
    let elapsedMs = 0;
    let reads = 1;
    const result = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt, cwd: projectDirectory, sleep: async (milliseconds) => { elapsedMs += milliseconds; reads += 1; },
    });

    expect(result).toBeNull();
    expect(elapsedMs).toBeGreaterThan(30_000);
    expect(elapsedMs).toBeLessThanOrEqual(35_000);
    // Each read opens the database on the main process: every 500 ms for the whole window would be 60 or more.
    expect(reads).toBeLessThan(40);
  });

  // OpenCode stores the resolved real path of the folder it runs in.
  it('finds a row whose directory is the real path behind a linked project', async () => {
    const spawnedAt = new Date();
    fs.mkdirSync(projectDirectory);
    const link = path.join(fakeHome, 'link-to-project');
    fs.symlinkSync(projectDirectory, link, 'junction');
    plantDatabase({});
    insertRow('session', 'ses_rowUnderTheRealPath', spawnedAt.getTime() + 400, fs.realpathSync.native(projectDirectory));

    const result = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt, cwd: link, maxAttempts: 1 });

    expect(result).toBe('ses_rowUnderTheRealPath');
  });

  // A subagent's session is a row in the same folder, newer than the session's
  // own. Its id would resume the subagent.
  it('never takes a subagent\'s row over the session that started it', async () => {
    const spawnedAt = new Date();
    plantDatabase({ session: [['ses_theTaskSessionItself', spawnedAt.getTime() + 400]] });
    const database = new Database(path.join(fakeHome, '.local', 'share', 'opencode', 'opencode.db'));
    database.exec('ALTER TABLE session ADD COLUMN parent_id TEXT');
    database.prepare(`INSERT INTO session (id, project_id, directory, time_created, time_updated, parent_id) VALUES (?, 'project', ?, ?, ?, ?)`)
      .run('ses_aSubagentOfTheSession', projectDirectory, spawnedAt.getTime() + 900, spawnedAt.getTime() + 900, 'ses_theTaskSessionItself');
    database.close();

    const result = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt, cwd: projectDirectory, maxAttempts: 1 });

    expect(result).toBe('ses_theTaskSessionItself');
  });

  // Both tables are read and merged newest first, whichever table holds the newest.
  it('takes the newest in-window row across both tables, in either order', async () => {
    const spawnedAt = new Date();
    plantDatabase({
      session: [['ses_olderInSession', spawnedAt.getTime() + 400]],
      sessionV2: [['ses_newerInSessionV2', spawnedAt.getTime() + 900]],
    });
    await expect(OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt, cwd: projectDirectory, maxAttempts: 1 }))
      .resolves.toBe('ses_newerInSessionV2');

    insertRow('session', 'ses_newestInSession', spawnedAt.getTime() + 1_500);
    await expect(OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt, cwd: projectDirectory, maxAttempts: 1 }))
      .resolves.toBe('ses_newestInSession');
  });

  it('stops polling once shouldContinue answers no, and keeps looking while it answers yes', async () => {
    const spawnedAt = new Date();
    plantDatabase({});

    let waits = 0;
    const stopAtOnce = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt, cwd: projectDirectory, sleep: async () => { waits += 1; }, shouldContinue: () => false,
    });
    expect(stopAtOnce).toBeNull();
    expect(waits).toBe(1);

    waits = 0;
    const stopAfterThree = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt, cwd: projectDirectory, sleep: async () => { waits += 1; }, shouldContinue: () => waits < 3,
    });
    expect(stopAfterThree).toBeNull();
    expect(waits).toBe(3);

    waits = 0;
    const found = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: projectDirectory,
      sleep: async () => {
        waits += 1;
        if (waits === 4) insertRow('session', 'ses_madeWhileWanted', spawnedAt.getTime() + 2_000);
      },
      shouldContinue: () => true,
    });
    expect(found).toBe('ses_madeWhileWanted');
  });

  it('locates a session that is only in session_v2', async () => {
    plantDatabase({ sessionV2: [['ses_e601c5bccffeTD1q4jpiKAT40X', Date.now()]] });

    const located = await OpenCodeSessionHistoryParser.locate({ agentSessionId: 'ses_e601c5bccffeTD1q4jpiKAT40X', cwd: projectDirectory });

    expect(located).toBe(path.join(fakeHome, '.local', 'share', 'opencode', 'opencode.db'));
  });

  it('warns about an incomplete session_v2 with no session table, naming the table, the missing column and the version', () => {
    const fixture = createDbWithSchema('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL)');
    const database = new Database(fixture.path, { readonly: true });
    try {
      verifyOpenCodeSchemaOnce(database, () => 'v2.2.5');
    } finally {
      database.close();
      fixture.cleanup();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0]);
    expect(message).toContain('`time_created`');
    expect(message).toContain('`session_v2` table');
    expect(message).toContain('(detected version: v2.2.5)');
    expect(message).toContain('Verified against 1.14.25 and 2.2.5');
  });

  it('does not warn about an incomplete session_v2 beside a complete session', () => {
    const fixture = createDbWithSchema(
      `CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
       CREATE TABLE session ${SESSION_TABLE_COLUMNS}`,
    );
    const database = new Database(fixture.path, { readonly: true });
    try {
      verifyOpenCodeSchemaOnce(database, () => 'v2.2.5');
    } finally {
      database.close();
      fixture.cleanup();
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns that the session table is missing when neither session table exists', () => {
    const fixture = createDbWithSchema('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
    const database = new Database(fixture.path, { readonly: true });
    try {
      verifyOpenCodeSchemaOnce(database, () => 'v2.2.5');
    } finally {
      database.close();
      fixture.cleanup();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('`session` table is missing');
  });

  it('does not warn about a fresh OpenCode 2 database, which has no session table at all', () => {
    const fixture = createDbWithSchema(`CREATE TABLE session_v2 ${SESSION_TABLE_COLUMNS}`);
    const database = new Database(fixture.path, { readonly: true });
    try {
      verifyOpenCodeSchemaOnce(database, () => 'v2.2.5');
    } finally {
      database.close();
      fixture.cleanup();
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
