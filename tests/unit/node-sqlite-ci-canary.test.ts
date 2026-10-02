/**
 * A canary for the real-database suites that skip themselves.
 *
 * Many unit suites run the app's real schema and store over `node:sqlite`
 * (better-sqlite3 is built for Electron's Node and cannot load under vitest).
 * Each of them opens with
 *
 *   try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
 *   const describeWithSqlite = sqlite ? describe : describe.skip;
 *
 * and the vec suites add `getLoadablePath()` from sqlite-vec to the same try.
 * That is right on a developer machine that has neither, and wrong on CI: if
 * the runner's Node drops `node:sqlite`, or the sqlite-vec platform package
 * fails to install, every one of them turns into a skip and the run is green
 * with the whole real-database layer untested. Among them:
 * retrieval-store-sql, vec-layout-migration, write-budget, transaction-helper,
 * index-builds-quiet, memory-chunks-indexes and retrieval-worker-methods.
 *
 * So on CI, where the toolchain is pinned (`.github/workflows/ci.yml` runs
 * Node 22, which has an unflagged `node:sqlite`), the prerequisites are
 * ASSERTED here instead of probed. Off CI these skip, by name, rather than fail:
 * a machine without them is a legitimate place to run the rest.
 *
 * The imports are the same ones the suites use, made inside the tests so a
 * failure carries the real error instead of a swallowed `catch`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

/** GitHub Actions (and most CI systems) set CI to a non-empty value. */
const runsOnCi = Boolean(process.env.CI) && process.env.CI !== 'false' && process.env.CI !== '0';

describe('real-database suite prerequisites', () => {
  it.skipIf(!runsOnCi)('CI only: node:sqlite imports, so the real-database suites run instead of skipping', async () => {
    const sqlite = await import('node:sqlite');
    expect(typeof sqlite.DatabaseSync).toBe('function');
    const database = new sqlite.DatabaseSync(':memory:');
    try {
      expect(database.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    } finally {
      database.close();
    }
  });

  it.skipIf(!runsOnCi)('CI only: sqlite-vec resolves a loadable extension path that exists on disk', async () => {
    const { getLoadablePath } = await import('sqlite-vec');
    const loadablePath = getLoadablePath();
    expect(typeof loadablePath).toBe('string');
    expect(loadablePath.length).toBeGreaterThan(0);
    expect(fs.existsSync(loadablePath)).toBe(true);
  });

  it.skipIf(!runsOnCi)('CI only: the sqlite-vec extension loads into a node:sqlite connection and answers', async () => {
    // What the vec suites do with the path once the gate lets them through. A path
    // that resolves but does not load would fail them one by one; failing here
    // names the cause once.
    const sqlite = await import('node:sqlite');
    const { getLoadablePath } = await import('sqlite-vec');
    const database = new sqlite.DatabaseSync(':memory:', { allowExtension: true });
    try {
      database.loadExtension(getLoadablePath());
      const row = database.prepare('SELECT vec_version() AS version').get() as { version: string };
      expect(typeof row.version).toBe('string');
      expect(row.version.length).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });
});
