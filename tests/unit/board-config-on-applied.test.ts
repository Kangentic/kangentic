/**
 * The per-column agent limit re-check after a board config applies.
 *
 * A teammate who removes or raises a column's limit in kangentic.json reaches
 * this process as a config apply (file watcher, project open). No session exits
 * when that happens, so nothing else re-checks the queue, and tasks stay queued
 * behind a limit that no longer exists. `BoardConfigManager.setOnConfigApplied`
 * is that re-check hook, and `register-all.ts` wires it to
 * `sessionManager.drainQueue()`.
 *
 * Red-green: delete the `this.onConfigApplied?.()` call in `applyConfig`, or the
 * `setOnConfigApplied(...)` line in `register-all.ts`, and the matching test
 * fails.
 *
 * The DB modules the import graph pulls in are mocked and `applyBoardConfigToDb`
 * is stubbed (same pattern as board-config-write-refusal-edges.test.ts), so this
 * stays a pure unit test with no database.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  applyBoardConfigToDb: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list() { return []; } },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class { list() { return []; } listTransitions() { return []; } },
}));
vi.mock('../../src/main/db/repositories/automation-repository', () => ({
  AutomationRepository: class { listAll() { return []; } listForColumn() { return []; } },
}));
vi.mock('../../src/main/config/board-config/apply-config', () => ({
  applyBoardConfigToDb: (...args: unknown[]) => hoisted.applyBoardConfigToDb(...args),
}));

import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { TEAM_FILE } from '../../src/main/config/board-config/config-helpers';

interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
  mainWindow: { isDestroyed(): boolean; webContents: { send: (channel: string, ...args: unknown[]) => void } } | null;
}

const validTeam = {
  version: 1,
  columns: [{ id: 'lane-1', name: 'To Do', role: 'todo' }],
};

describe('BoardConfigManager setOnConfigApplied', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-on-applied-'));
    fs.writeFileSync(path.join(tempDir, TEAM_FILE), JSON.stringify(validTeam));
    hoisted.applyBoardConfigToDb.mockReset();
    hoisted.applyBoardConfigToDb.mockReturnValue({ warnings: [] });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function attachedManager(): BoardConfigManager {
    const manager = new BoardConfigManager({ ephemeral: false });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'project-1';
    internals.activeProjectPath = tempDir;
    internals.mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    return manager;
  }

  it('runs the registered listener once when a config is applied', () => {
    const manager = attachedManager();
    const listener = vi.fn();
    manager.setOnConfigApplied(listener);

    manager.applyConfig('project-1', tempDir);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('runs the listener after the config reached the database, not before', () => {
    const manager = attachedManager();
    const order: string[] = [];
    hoisted.applyBoardConfigToDb.mockImplementation(() => {
      order.push('applied');
      return { warnings: [] };
    });
    manager.setOnConfigApplied(() => order.push('listener'));

    manager.applyConfig('project-1', tempDir);

    expect(order).toEqual(['applied', 'listener']);
  });

  it('runs the listener on every apply, not only the first', () => {
    const manager = attachedManager();
    const listener = vi.fn();
    manager.setOnConfigApplied(listener);

    manager.applyConfig('project-1', tempDir);
    manager.applyConfig('project-1', tempDir);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('applies without throwing when no listener is registered', () => {
    const manager = attachedManager();

    expect(() => manager.applyConfig('project-1', tempDir)).not.toThrow();
    expect(hoisted.applyBoardConfigToDb).toHaveBeenCalledTimes(1);
  });

  it('keeps only the most recently registered listener', () => {
    const manager = attachedManager();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    manager.setOnConfigApplied(firstListener);
    manager.setOnConfigApplied(secondListener);

    manager.applyConfig('project-1', tempDir);

    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledTimes(1);
  });
});

// The listener only helps if production registers one that drains the queue.
// register-all.ts builds the whole app (Electron, utility processes), so it is
// read as source rather than run.
describe('register-all wires the config-applied listener to the queue drain', () => {
  const registerAllSource = fs.readFileSync(
    path.join(__dirname, '../../src/main/ipc/register-all.ts'),
    'utf-8',
  );

  it('registers setOnConfigApplied on the board config manager with sessionManager.drainQueue', () => {
    expect(registerAllSource).toMatch(
      /boardConfigManager\.setOnConfigApplied\(\s*\(\)\s*=>\s*sessionManager\.drainQueue\(\)\s*\)/,
    );
  });
});
