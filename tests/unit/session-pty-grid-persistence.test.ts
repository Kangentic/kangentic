/**
 * The PTY grid a session last had, persisted on its record (`last_pty_cols` /
 * `last_pty_rows`) so a resume after a desktop restart or a pty host crash
 * spawns at it instead of the 120x30 default. In memory a respawn already
 * starts at its predecessor's grid; this is the copy that outlives the registry.
 *
 * Covers the write path (the repository UPDATE and the `pty-resize` listener's
 * persistPtyGrid) and the read path (recordedPtyGrid and the spawn intent).
 *
 * better-sqlite3 is compiled for Electron's Node ABI and cannot load under
 * vitest's system Node, so the repository runs over a capturing mock DB, as in
 * session-repository-applied-settings.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

const hoisted = vi.hoisted(() => ({
  openDb: null as unknown,
  shuttingDown: false,
}));

vi.mock('../../src/main/db/database', () => ({
  getOpenProjectDb: vi.fn(() => hoisted.openDb),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => hoisted.shuttingDown,
}));

import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { recordedPtyGrid } from '../../src/main/db/recorded-pty-grid';
import { persistPtyGrid } from '../../src/main/ipc/handlers/session-grid-persistence';
import { resolveSpawnIntent } from '../../src/main/transition-engine/spawn-intent';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { SessionRecord } from '../../src/shared/types';

function createCapturingMockDb(): { db: Database.Database; prepared: string[]; runParams: unknown[][] } {
  const prepared: string[] = [];
  const runParams: unknown[][] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      prepared.push(sql);
      return {
        run: vi.fn((...params: unknown[]) => {
          runParams.push(params);
          return { changes: 1 };
        }),
        get: vi.fn(),
        all: vi.fn(() => []),
      };
    }),
  } as unknown as Database.Database;
  return { db, prepared, runParams };
}

function contextFor(projectId: string | undefined): Pick<IpcContext, 'sessionManager'> {
  return {
    sessionManager: { getSessionProjectId: () => projectId },
  } as unknown as Pick<IpcContext, 'sessionManager'>;
}

const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('SessionRepository grid columns', () => {
  it('updatePtyGrid writes both columns for the record', () => {
    const { db, prepared, runParams } = createCapturingMockDb();

    new SessionRepository(db).updatePtyGrid('session-1', { cols: 210, rows: 48 });

    expect(prepared[0]).toContain('last_pty_cols = ?');
    expect(prepared[0]).toContain('last_pty_rows = ?');
    expect(runParams[0]).toEqual([210, 48, 'session-1']);
  });

  it('insert returns the grid as null (recorded later from grid events)', () => {
    const { db } = createCapturingMockDb();

    const record = new SessionRepository(db).insert({
      id: 'session-1',
      task_id: 'task-1',
      session_type: 'claude_agent',
      isolated_swimlane_id: null,
      agent_session_id: 'agent-1',
      command: 'claude',
      cwd: '/project',
      permission_mode: null,
      prompt: null,
      status: 'running',
      exit_code: null,
      started_at: '2026-10-03T00:00:00Z',
      suspended_at: null,
      exited_at: null,
      suspended_by: null,
    });

    expect(record.last_pty_cols).toBeNull();
    expect(record.last_pty_rows).toBeNull();
  });
});

describe('recordedPtyGrid', () => {
  it('reads a grid only when both columns are set', () => {
    expect(recordedPtyGrid({ last_pty_cols: 210, last_pty_rows: 48 })).toEqual({ cols: 210, rows: 48 });
    expect(recordedPtyGrid({ last_pty_cols: 210, last_pty_rows: null })).toBeUndefined();
    expect(recordedPtyGrid({ last_pty_cols: null, last_pty_rows: null })).toBeUndefined();
    expect(recordedPtyGrid(null)).toBeUndefined();
    // A row object from before the columns existed carries neither key.
    expect(recordedPtyGrid({} as Pick<SessionRecord, 'last_pty_cols' | 'last_pty_rows'>)).toBeUndefined();
  });
});

describe('persistPtyGrid (the pty-resize listener)', () => {
  let capture: ReturnType<typeof createCapturingMockDb>;

  beforeEach(() => {
    capture = createCapturingMockDb();
    hoisted.openDb = capture.db;
    hoisted.shuttingDown = false;
  });

  it('writes a desktop or park grid at once', () => {
    persistPtyGrid(contextFor('project-1'), 'session-1', { cols: 190, rows: 50 }, 'desktop');
    persistPtyGrid(contextFor('project-1'), 'session-1', { cols: 210, rows: 48 }, 'park');

    expect(capture.runParams).toEqual([[190, 50, 'session-1'], [210, 48, 'session-1']]);
  });

  /**
   * The spawn announces its grid inside sessionManager.spawn(), before the
   * caller inserts the record, so an immediate UPDATE would match no row.
   */
  it('defers the spawn announcement past the record insert', async () => {
    persistPtyGrid(contextFor('project-1'), 'session-1', { cols: 210, rows: 48 }, 'spawn');

    expect(capture.runParams).toEqual([]);
    await nextMacrotask();
    expect(capture.runParams).toEqual([[210, 48, 'session-1']]);
  });

  it('never records a phone-held grid', async () => {
    persistPtyGrid(contextFor('project-1'), 'session-1', { cols: 80, rows: 40 }, 'mobile');
    await nextMacrotask();

    expect(capture.runParams).toEqual([]);
  });

  it('writes nothing during shutdown, including a deferred spawn write', async () => {
    hoisted.shuttingDown = true;
    persistPtyGrid(contextFor('project-1'), 'session-1', { cols: 190, rows: 50 }, 'desktop');
    expect(capture.runParams).toEqual([]);

    hoisted.shuttingDown = false;
    persistPtyGrid(contextFor('project-1'), 'session-2', { cols: 210, rows: 48 }, 'spawn');
    hoisted.shuttingDown = true;
    await nextMacrotask();
    expect(capture.runParams).toEqual([]);
  });

  it('never opens a project database that is not already open', () => {
    hoisted.openDb = null;

    persistPtyGrid(contextFor('project-1'), 'session-1', { cols: 190, rows: 50 }, 'desktop');

    expect(capture.runParams).toEqual([]);
  });

  it('skips a session with no project (gone from the registry)', () => {
    persistPtyGrid(contextFor(undefined), 'session-1', { cols: 190, rows: 50 }, 'desktop');

    expect(capture.runParams).toEqual([]);
  });
});

describe('resolveSpawnIntent carries the retired record grid', () => {
  function repoReturning(record: Partial<SessionRecord> | null): SessionRepository {
    return {
      getLatestForTaskByTypeAndIsolation: vi.fn(() => record),
    } as unknown as SessionRepository;
  }

  const baseRecord: Partial<SessionRecord> = {
    id: 'record-1',
    session_type: 'claude_agent',
    agent_session_id: 'agent-1',
    status: 'suspended',
    cwd: '/project',
    last_pty_cols: 210,
    last_pty_rows: 48,
  };

  function resolve(record: Partial<SessionRecord> | null, forceFresh = false) {
    return resolveSpawnIntent({
      taskId: 'task-1',
      sessionType: 'claude_agent',
      sessionRepo: repoReturning(record),
      promptTemplate: undefined,
      templateVars: {},
      resumePrompt: undefined,
      forceFresh,
    });
  }

  it('on a resume', () => {
    const intent = resolve(baseRecord);
    expect(intent.mode).toBe('resume');
    expect(intent.restoredGrid).toEqual({ cols: 210, rows: 48 });
  });

  it('on a forced-fresh entry, which still retires that record', () => {
    const intent = resolve(baseRecord, true);
    expect(intent.mode).toBe('fresh');
    expect(intent.retireRecordId).toBe('record-1');
    expect(intent.restoredGrid).toEqual({ cols: 210, rows: 48 });
  });

  it('not when nothing is retired, or the record has no grid', () => {
    expect(resolve({ ...baseRecord, agent_session_id: null }).restoredGrid).toBeUndefined();
    expect(resolve({ ...baseRecord, last_pty_cols: null, last_pty_rows: null }).restoredGrid).toBeUndefined();
    expect(resolve(null).restoredGrid).toBeUndefined();
  });
});
