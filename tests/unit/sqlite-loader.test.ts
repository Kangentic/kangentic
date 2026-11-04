/**
 * `loadBetterSqlite3` (src/main/agent/shared/sqlite-loader.ts): the lazy loader
 * the OpenCode and Goose readers share. What a user loses if it breaks: a
 * platform with no better-sqlite3 prebuild must degrade to "no history" (null)
 * rather than crash the reader, and a loaded driver must not be re-resolved on
 * every poll.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Module from 'node:module';

type ModuleLoad = (request: string, ...rest: unknown[]) => unknown;
const moduleInternals = Module as unknown as { _load: ModuleLoad };

const DRIVER = 'better-sqlite3';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadBetterSqlite3', () => {
  it('returns the driver constructor, resolving the native module once for repeated calls', async () => {
    const originalLoad = moduleInternals._load;
    const requested: string[] = [];
    vi.spyOn(moduleInternals, '_load').mockImplementation(function (this: unknown, request: string, ...rest: unknown[]) {
      requested.push(request);
      return originalLoad.call(this, request, ...rest);
    });

    const { loadBetterSqlite3 } = await import('../../src/main/agent/shared/sqlite-loader');
    const first = loadBetterSqlite3();
    const second = loadBetterSqlite3();

    expect(first).toBeTypeOf('function');
    expect(second).toBe(first);
    expect(requested.filter((request) => request === DRIVER)).toHaveLength(1);
    // And it is a usable driver, not an empty module object.
    const database = new first!(':memory:');
    expect(database.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    database.close();
  });

  it('returns null, not a throw, when the native module cannot be loaded', async () => {
    const originalLoad = moduleInternals._load;
    vi.spyOn(moduleInternals, '_load').mockImplementation(function (this: unknown, request: string, ...rest: unknown[]) {
      if (request === DRIVER) throw new Error('No native build was found for this platform');
      return originalLoad.call(this, request, ...rest);
    });

    const { loadBetterSqlite3 } = await import('../../src/main/agent/shared/sqlite-loader');
    expect(loadBetterSqlite3()).toBeNull();
  });

  it('is the loader OpenCode\'s session-history-parser re-exports for its importers', async () => {
    const shared = await import('../../src/main/agent/shared/sqlite-loader');
    const openCode = await import('../../src/main/agent/adapters/opencode/session-history-parser');
    expect(openCode.loadBetterSqlite3).toBe(shared.loadBetterSqlite3);
  });
});
