/**
 * The reservation ledger must degrade, never throw, when the global database
 * cannot be opened.
 *
 * This is not a hypothetical. `better-sqlite3` is an Electron ABI build, so
 * under plain Node - which is how the unit tier runs on CI - `getGlobalDb()`
 * throws `NODE_MODULE_VERSION` on its first call. The ledger lives in the
 * global database while its callers are per-project TASK paths: serializing a
 * task, resolving `{{port}}`, deleting a task. When those throws propagated,
 * fourteen tests across five files that have nothing to do with dev ports went
 * red on CI, while every one of them passed locally where the native module
 * happened to load.
 *
 * That local-vs-CI asymmetry is exactly why this file forces the failure
 * explicitly instead of trusting the ambient environment: a test that only
 * fails where better-sqlite3 is unloadable is a test that proves nothing on the
 * machine where the code is written.
 *
 * The property being pinned is a design one, not a workaround. A lease row is
 * advisory (the bind probe is the authority), so "the ledger is unreachable"
 * must read as "this task holds no reservations" - never as a failed task
 * delete or a failed spawn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getGlobalDb = vi.fn(() => {
  throw new Error(
    "The module '/x/better_sqlite3.node' was compiled against a different Node.js version using "
    + 'NODE_MODULE_VERSION 145. This version of Node.js requires NODE_MODULE_VERSION 127.',
  );
});

vi.mock('../../src/main/db/database', () => ({
  getGlobalDb: () => getGlobalDb(),
}));

const { devPortRepository } = await import('../../src/main/db/repositories/dev-port-repository');

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getGlobalDb.mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('DevPortRepository with an unreachable global database', () => {
  it('reports no reservations rather than throwing', () => {
    expect(() => devPortRepository.listForTask('task-1')).not.toThrow();
    expect(devPortRepository.listForTask('task-1')).toEqual([]);
    // The read really was attempted - this is not passing because some cache
    // short-circuited before reaching the database.
    expect(getGlobalDb).toHaveBeenCalled();
  });

  it('resolves {{port}} to nothing rather than throwing', () => {
    expect(devPortRepository.getByTaskId('task-1')).toBeNull();
  });

  it('treats every port as unclaimed rather than throwing', () => {
    expect(devPortRepository.getByPort(7300)).toBeNull();
  });

  it('reports a failed claim rather than throwing', () => {
    // False is the same answer a lost race gives, which callers already retry
    // or surface as "no ports available" - so no caller needs a new branch.
    expect(devPortRepository.claim(7300, 'proj-1', 'task-1')).toBe(false);
  });

  it('lets a task deletion complete rather than throwing', () => {
    // The one that matters most: TaskRepository.delete calls this AFTER the
    // project-scoped transaction has committed. A throw here would surface as a
    // failed delete on a task that is already gone.
    expect(() => devPortRepository.releaseByTaskId('task-1')).not.toThrow();
  });

  it('warns ONCE, not once per call', () => {
    // A standing condition, not a per-call event. One line per task
    // serialization would bury every other diagnostic in the log.
    for (let index = 0; index < 25; index += 1) {
      devPortRepository.listForTask(`task-${index}`);
      devPortRepository.getByPort(7300 + index);
    }
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
