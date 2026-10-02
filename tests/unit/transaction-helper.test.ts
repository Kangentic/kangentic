/**
 * `writeTransaction` (src/main/db/transaction.ts): every transaction takes the
 * write lock when it begins.
 *
 * Two processes write each project database, main and the retrieval worker,
 * and SQLite lets one write at a time. A DEFERRED transaction that reads before
 * it writes cannot wait for the lock at its first write: SQLite fails it at
 * once with SQLITE_BUSY, whatever the busy timeout. An IMMEDIATE one takes the
 * lock at BEGIN, where the timeout applies, and waits. These tests pin that on
 * two real connections to one WAL file, and pin that no code begins a
 * transaction any other way.
 *
 * node:sqlite rather than better-sqlite3, which is compiled for Electron's
 * Node ABI and cannot load here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setAfterCommitHook, writeTransaction } from '../../src/main/db/transaction';
import { relaySlowSyncSpans } from '../../src/main/diagnostics/event-loop-lag';
import { adaptDatabase, type NodeDatabase } from './helpers/node-sqlite-database';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

const SRC = path.resolve(__dirname, '..', '..', 'src');
const HELPER = path.join(SRC, 'main', 'db', 'transaction.ts');

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('transactions begin through writeTransaction', () => {
  it('no source file calls .transaction( itself', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === HELPER) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
        if (/\.transaction\(/.test(code)) offenders.push(`${path.relative(SRC, file)}:${index + 1}`);
      });
    }
    expect(offenders, 'use writeTransaction from src/main/db/transaction.ts').toEqual([]);
  });
});

describeWithSqlite('two connections to one WAL database', () => {
  const directories: string[] = [];
  const open: NodeDatabase[] = [];

  afterEach(() => {
    for (const database of open.splice(0)) database.close();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  /** A WAL database with one table, a connection holding its write lock, and a
   *  second connection whose busy timeout is `busyTimeoutMs`. */
  function lockedByAnother(busyTimeoutMs: number) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transaction-'));
    directories.push(directory);
    const file = path.join(directory, 'project.db');
    const holder = new sqlite!.DatabaseSync(file);
    open.push(holder);
    holder.exec('PRAGMA journal_mode = WAL');
    holder.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    holder.exec("INSERT INTO items (name) VALUES ('first')");
    const waiting = new sqlite!.DatabaseSync(file);
    open.push(waiting);
    waiting.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // The other process mid-write: it holds the lock until it commits.
    holder.exec("BEGIN IMMEDIATE; INSERT INTO items (name) VALUES ('held')");
    return { holder, db: adaptDatabase(waiting) };
  }

  /** How long `run` took before it threw, and what it threw. */
  function timedFailure(run: () => void): { elapsedMs: number; message: string } {
    const startedAt = performance.now();
    try {
      run();
    } catch (error) {
      return { elapsedMs: performance.now() - startedAt, message: String(error) };
    }
    throw new Error('expected the transaction to fail while the other connection held the lock');
  }

  const readThenWrite = (db: ReturnType<typeof lockedByAnother>['db']) => () => {
    db.prepare('SELECT COUNT(*) AS count FROM items').get();
    db.prepare("INSERT INTO items (name) VALUES ('second')").run();
  };

  it('a deferred read-then-write fails at once, however long the busy timeout', () => {
    const { db } = lockedByAnother(2_000);
    const failure = timedFailure(() => db.transaction(readThenWrite(db))());
    expect(failure.message).toMatch(/database is locked|SQLITE_BUSY/i);
    // Well short of the 2 s timeout: the upgrade never waited.
    expect(failure.elapsedMs).toBeLessThan(1_000);
  });

  it('writeTransaction takes the lock at BEGIN, so it waits out the busy timeout', () => {
    const { db } = lockedByAnother(150);
    const failure = timedFailure(() => writeTransaction(db, readThenWrite(db))());
    expect(failure.message).toMatch(/database is locked|SQLITE_BUSY/i);
    expect(failure.elapsedMs).toBeGreaterThanOrEqual(140);
  });

  it('writeTransaction commits once the other connection releases the lock', () => {
    const { holder, db } = lockedByAnother(150);
    holder.exec('COMMIT');
    writeTransaction(db, readThenWrite(db))();
    const names = (holder.prepare('SELECT name FROM items ORDER BY id').all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(['first', 'held', 'second']);
  });
});

/**
 * The after-commit hook is where the retrieval worker paces its checkpoints
 * (`worker/checkpoint-pacing.ts`). It must run once per outermost commit, with
 * the write lock already released, and never for a savepoint or a rollback.
 * Both paths are covered: span timing on (dev builds) and off.
 */
describeWithSqlite('the after-commit hook', () => {
  const directories: string[] = [];
  const open: NodeDatabase[] = [];

  afterEach(() => {
    setAfterCommitHook(null);
    relaySlowSyncSpans(null);
    for (const database of open.splice(0)) database.close();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function database() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-after-commit-'));
    directories.push(directory);
    const handle = new sqlite!.DatabaseSync(path.join(directory, 'project.db'));
    open.push(handle);
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    return adaptDatabase(handle);
  }

  for (const timed of [false, true]) {
    describe(timed ? 'with span timing on' : 'with span timing off', () => {
      it('runs once after an outermost commit, outside the transaction', () => {
        if (timed) relaySlowSyncSpans(() => undefined);
        const db = database();
        const seen: boolean[] = [];
        setAfterCommitHook((connection) => { seen.push(connection.inTransaction); });
        const result = writeTransaction(db, () => {
          db.prepare("INSERT INTO items (name) VALUES ('one')").run();
          return 'done';
        })();
        expect(result).toBe('done');
        expect(seen).toEqual([false]);
      });

      it('does not run for a nested savepoint, only for the outer commit', () => {
        if (timed) relaySlowSyncSpans(() => undefined);
        const db = database();
        let calls = 0;
        setAfterCommitHook(() => { calls += 1; });
        const inner = writeTransaction(db, () => db.prepare("INSERT INTO items (name) VALUES ('inner')").run());
        writeTransaction(db, () => {
          inner();
          inner();
          expect(calls).toBe(0);
        })();
        expect(calls).toBe(1);
      });

      it('does not run when the transaction rolls back', () => {
        if (timed) relaySlowSyncSpans(() => undefined);
        const db = database();
        let calls = 0;
        setAfterCommitHook(() => { calls += 1; });
        expect(() => writeTransaction(db, () => {
          db.prepare("INSERT INTO items (name) VALUES ('lost')").run();
          throw new Error('body failed');
        })()).toThrow('body failed');
        expect(calls).toBe(0);
      });

      it('keeps the committed result when the hook throws', () => {
        if (timed) relaySlowSyncSpans(() => undefined);
        const db = database();
        setAfterCommitHook(() => { throw new Error('checkpoint failed'); });
        expect(writeTransaction(db, () => {
          db.prepare("INSERT INTO items (name) VALUES ('kept')").run();
          return 'committed';
        })()).toBe('committed');
        expect((db.prepare('SELECT COUNT(*) AS count FROM items').get() as { count: number }).count).toBe(1);
      });
    });
  }
});
