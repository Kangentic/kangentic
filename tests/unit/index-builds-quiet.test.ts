/**
 * The index builds wait for a quiet database (`index-builds.ts`). A build holds
 * the write lock for 180 to 245 ms on the real install, and built at the open
 * sweep it landed on main's startup writes, which sat in SQLite's busy wait for
 * 542 ms. So each build waits until no OTHER connection has committed for
 * `quietMs`, read from `PRAGMA data_version`, which moves for another
 * connection's commits and never for this one's own.
 *
 * Two real node:sqlite connections on one file: the worker's, adapted, and a
 * second standing in for main. The clock and the sleep are injected, so the
 * waits take no real time.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import {
  buildMissingIndexesWhenQuiet,
  missingRetrievalIndexes,
  waitForQuietDatabase,
  RETRIEVAL_INDEXES,
  type QuietGateTiming,
} from '../../src/main/retrieval/index-builds';
import { adaptDatabase, type NodeDatabase } from './helpers/node-sqlite-database';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

const TIMING: QuietGateTiming = { quietMs: 2_000, pollMs: 250, capMs: 60_000 };

describeWithSqlite('index builds wait for a quiet database', () => {
  let directory: string;
  let worker: NodeDatabase;
  let main: NodeDatabase;
  let workerDb: DatabaseType.Database;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'index-builds-quiet-'));
    const file = path.join(directory, 'project.db');
    worker = new sqlite!.DatabaseSync(file);
    worker.exec('PRAGMA journal_mode = WAL');
    workerDb = adaptDatabase(worker);
    runProjectMigrations(workerDb);
    main = new sqlite!.DatabaseSync(file);
    main.exec('CREATE TABLE board (id INTEGER PRIMARY KEY, title TEXT)');
  });

  afterEach(() => {
    worker.close();
    main.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** A clock that moves only when the gate sleeps, and main committing at the
   *  given times (ms from the start). */
  function scripted(mainCommitsAt: number[], stopAt = Infinity) {
    let clock = 0;
    const pending = [...mainCommitsAt];
    const commits: number[] = [];
    return {
      deps: {
        now: () => clock,
        shouldContinue: () => clock < stopAt,
        sleep: async (ms: number) => {
          clock += ms;
          while (pending.length > 0 && pending[0] <= clock) {
            commits.push(pending.shift()!);
            main.prepare('INSERT INTO board (title) VALUES (?)').run('card');
          }
        },
      },
      clock: () => clock,
      commits,
    };
  }

  it('opens once no other connection has committed for the quiet window', async () => {
    // Main writes for the first second and a half, then stops.
    const script = scripted([250, 750, 1500]);
    const result = await waitForQuietDatabase(workerDb, script.deps, TIMING);
    expect(result).toBe('quiet');
    expect(script.commits).toEqual([250, 750, 1500]);
    // Two seconds after the last commit, not two seconds after the start.
    expect(script.clock()).toBe(3500);
  });

  it('is not held shut by the worker connection\'s own writes', async () => {
    const script = scripted([]);
    let clock = 0;
    const deps = {
      ...script.deps,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
        worker.prepare("INSERT INTO memory_meta (key, value) VALUES ('probe', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(clock));
      },
    };
    expect(await waitForQuietDatabase(workerDb, deps, TIMING)).toBe('quiet');
    expect(clock).toBe(2000);
  });

  it('runs anyway at the cap when the database is never quiet, and says so', async () => {
    const everySecond = Array.from({ length: 70 }, (_, index) => (index + 1) * 1000);
    const script = scripted(everySecond);
    expect(await waitForQuietDatabase(workerDb, script.deps, TIMING)).toBe('cap');
    expect(script.clock()).toBe(60_000);
  });

  it('stops when the job is cancelled', async () => {
    const script = scripted([500, 1000, 1500, 2000], 1200);
    expect(await waitForQuietDatabase(workerDb, script.deps, TIMING)).toBe('stopped');
  });

  it('builds every missing index, each after its own quiet wait, and none once they exist', async () => {
    const script = scripted([100, 300]);
    const built = await buildMissingIndexesWhenQuiet(workerDb, script.deps, TIMING);
    expect(built.map((index) => index.name)).toEqual(RETRIEVAL_INDEXES.map((index) => index.name));
    expect(built.every((index) => index.after === 'quiet')).toBe(true);
    // The first waits out main's writes, timed from the poll that saw the last
    // one (500 ms); each later one waits a full window again.
    expect(script.clock()).toBe(2500 + 3 * 2000);
    expect(missingRetrievalIndexes(workerDb)).toEqual([]);
    expect(await buildMissingIndexesWhenQuiet(workerDb, scripted([]).deps, TIMING)).toEqual([]);
  });

  it('builds nothing more once cancelled', async () => {
    const script = scripted([], 2100);
    const built = await buildMissingIndexesWhenQuiet(workerDb, script.deps, TIMING);
    expect(built).toHaveLength(1);
    expect(missingRetrievalIndexes(workerDb)).toHaveLength(RETRIEVAL_INDEXES.length - 1);
  });
});
