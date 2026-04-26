/**
 * Live-DB integration test for OpenCodeSessionHistoryParser.
 *
 * This test runs only when an actual `~/.local/share/opencode/opencode.db`
 * exists on the developer's machine, i.e. the developer has installed
 * OpenCode and run at least one session. It validates the parser's
 * SQLite read path against real data, which pure unit tests against
 * mocked filesystems cannot exercise.
 *
 * If no DB is present, all tests are skipped (clean exit). CI machines
 * without OpenCode installed will simply not run them.
 */
import { describe, it, expect } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeSessionHistoryParser } from '../../src/main/agent/adapters/opencode/session-history-parser';

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const HAS_DB = fs.existsSync(DB_PATH);

// Lazy-load better-sqlite3 and probe-open the live DB once. Both the
// `require()` and the first `new Database()` can fail with
// NODE_MODULE_VERSION mismatch (system Node vs. the rebuild target),
// because better-sqlite3 defers its native-binding load until
// instantiation. We swallow both failures and degrade to a skip so a
// developer running tests under raw Node still gets a clean report.
function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    const moduleName = 'better-sqlite3';
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = ((nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule) as typeof DatabaseType;
    if (HAS_DB) {
      const probeHandle = new databaseConstructor(DB_PATH, { readonly: true, fileMustExist: true });
      probeHandle.close();
    }
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = HAS_DB && Database !== null;

interface SessionRow {
  id: string;
  directory: string;
  time_created: number;
  time_updated: number;
  title: string;
}

function readMostRecentSession(): SessionRow | null {
  if (!CAN_RUN || !Database) return null;
  const database = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const row = database
      .prepare<[], SessionRow>(
        'SELECT id, directory, time_created, time_updated, title FROM session ORDER BY time_created DESC LIMIT 1',
      )
      .get();
    return row ?? null;
  } finally {
    database.close();
  }
}

describe.runIf(CAN_RUN)('OpenCodeSessionHistoryParser - live DB', () => {
  const target = readMostRecentSession();

  it('precondition: at least one session row exists', () => {
    expect(target).not.toBeNull();
    expect(target?.id).toMatch(/^ses_/);
  });

  it('captureSessionIdFromFilesystem returns the right ID for a window matching time_created', async () => {
    if (!target) return;
    const captured = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(target.time_created),
      cwd: target.directory,
      maxAttempts: 1,
    });
    expect(captured).toBe(target.id);
  });

  it('captureSessionIdFromFilesystem returns null when spawnedAt is well outside the window', async () => {
    if (!target) return;
    const captured = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(target.time_created + 60_000 + 1),
      cwd: target.directory,
      maxAttempts: 1,
    });
    expect(captured).toBeNull();
  });

  it('captureSessionIdFromFilesystem returns null when cwd does not match', async () => {
    if (!target) return;
    const captured = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(target.time_created),
      cwd: process.platform === 'win32' ? 'C:\\nope\\does\\not\\exist' : '/nope/does/not/exist',
      maxAttempts: 1,
    });
    expect(captured).toBeNull();
  });

  it('locate returns the opencode.db path for an existing session ID', async () => {
    if (!target) return;
    const located = await OpenCodeSessionHistoryParser.locate({
      agentSessionId: target.id,
      cwd: target.directory,
    });
    expect(located).toBe(DB_PATH);
  });

  it('locate returns null for a bogus session ID', async () => {
    if (!target) return;
    const located = await OpenCodeSessionHistoryParser.locate({
      agentSessionId: 'ses_bogus_does_not_exist_xx',
      cwd: target.directory,
    });
    expect(located).toBeNull();
  });

  it('cwd comparison is case-insensitive on Windows', async () => {
    if (!target) return;
    const upcased = target.directory.toUpperCase();
    const captured = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(target.time_created),
      cwd: upcased,
      maxAttempts: 1,
    });
    if (process.platform === 'win32') {
      expect(captured).toBe(target.id);
    } else {
      // On Unix the comparison is case-sensitive, so an upper-cased
      // version of the directory must NOT match.
      expect(captured).toBeNull();
    }
  });
});

describe.runIf(!CAN_RUN)('OpenCodeSessionHistoryParser - live DB (skipped)', () => {
  it('skipped because the OpenCode DB is missing or better-sqlite3 cannot load', () => {
    // Either no install (HAS_DB=false) or native-module ABI mismatch
    // (Database=null). Both are acceptable - we just want the suite
    // to record a clean skip rather than a hard error.
    expect(CAN_RUN).toBe(false);
  });
});
