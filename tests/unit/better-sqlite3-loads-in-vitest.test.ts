/**
 * A canary for the unit suites that run on a real better-sqlite3 database.
 *
 * Until better-sqlite3 13 the binding was rebuilt for Electron's Node ABI and
 * could not load under vitest's plain Node. Eighteen suites probed for it and
 * skipped everywhere, CI included, and about thirty more ran on node:sqlite
 * behind an adapter. 13 is a Node-API module that ships its own prebuilds, so the
 * same binary loads under Electron and here, and all of those suites now open the
 * real driver directly (tests/unit/helpers/test-database.ts) with no skip path.
 *
 * So a regression here (a runner Node without Node-API 10, a prebuild missing for
 * the platform, a downgrade to an ABI-specific build) fails dozens of suites at
 * once. This file names the cause in one place. It is not CI-only: every supported
 * platform has a prebuild, so there is no legitimate machine where it fails.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { nodeApiFloorError, REQUIRED_NODE_API } from './helpers/node-api-floor';

const requireFromTest = createRequire(import.meta.url);

describe('better-sqlite3 loads under vitest', () => {
  it('opens an in-memory database and answers a query', () => {
    const Database = requireFromTest('better-sqlite3') as typeof DatabaseType;
    const database = new Database(':memory:');
    try {
      expect(database.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    } finally {
      database.close();
    }
  });

  it('runs on a Node with the Node-API version the prebuilds need', () => {
    // better-sqlite3 13 builds against Node-API 10 (Node 22.14+ and Electron 44's Node 24).
    expect(Number(process.versions.napi)).toBeGreaterThanOrEqual(REQUIRED_NODE_API);
  });

  it('has the global setup refuse a Node below that floor, by name, instead of segfaulting', () => {
    // 22.13 is the last Node 22 with Node-API 9, the case better-sqlite3#1514 reports.
    expect(nodeApiFloorError({ node: '22.13.1', napi: '9' })).toMatch(/Node-API 10 \(Node 22\.14\+ or 24\+\).*22\.13\.1/);
    expect(nodeApiFloorError({ node: '22.0.0' })).toMatch(/Node-API unknown/);
    expect(nodeApiFloorError({ node: '22.14.0', napi: '10' })).toBeNull();
    expect(nodeApiFloorError({ node: '24.21.0', napi: '10' })).toBeNull();
  });

  it('loads the sqlite-vec extension into a connection, as the retrieval worker does', async () => {
    // The vec suites open their databases through openTestDatabase({ vec: true }),
    // so a missing sqlite-vec platform package fails them one by one; this names
    // the cause once. It replaced node-sqlite-ci-canary.test.ts, which guarded the
    // same thing for the node:sqlite suites before they moved to this driver.
    const { getLoadablePath } = await import('sqlite-vec');
    const Database = requireFromTest('better-sqlite3') as typeof DatabaseType;
    const database = new Database(':memory:');
    try {
      database.loadExtension(getLoadablePath());
      const row = database.prepare('SELECT vec_version() AS version').get() as { version: string };
      expect(row.version).toMatch(/^v\d/);
    } finally {
      database.close();
    }
  });
});

describe('the unit tier never opens the real data directory', () => {
  // Because the driver loads, a suite that reaches the real getGlobalDb() now
  // opens a real database: the developer's own, unless the data directory is
  // redirected. tests/unit/helpers/isolate-data-dir.ts does that per file; this
  // fails if it stops being registered.
  it('resolves PATHS.configDir to a throwaway directory, not the per-user one', async () => {
    const { PATHS, getPlatformConfigDir } = await import('../../src/main/config/paths');
    expect(PATHS.configDir).not.toBe(getPlatformConfigDir());
    expect(PATHS.configDir.startsWith(os.tmpdir())).toBe(true);
  });

  it.skipIf(process.platform === 'darwin')('resolves the model cache to a throwaway directory too', async () => {
    // It ignores KANGENTIC_DATA_DIR by design and follows the platform config
    // base, which the setup file redirects on Windows and Linux (not macOS,
    // where that base is the home directory).
    const { PATHS } = await import('../../src/main/config/paths');
    expect(PATHS.modelCacheDir.startsWith(os.tmpdir())).toBe(true);
  });
});
