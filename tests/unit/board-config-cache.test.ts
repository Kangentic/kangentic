/**
 * Regression lock for the BoardConfigManager read memo.
 *
 * getDefaultBaseBranch() fires on every task finalization and every renderer
 * CONFIG_GET; it used to re-read + re-parse kangentic.json AND
 * kangentic.local.json synchronously each time, stalling the main-process
 * event loop under a batch of finalizations. The memo caches the ACTIVE
 * project's parsed files and is invalidated by every write path and by the
 * FileWatcher on external edits.
 *
 * better-sqlite3 cannot load under vitest, so the DB modules the import graph
 * pulls in are mocked (same pattern as board-config-onfilechange.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
// list()/listTransitions() stubs (empty) are needed by the writeBackForProject
// cache-invalidation test below, which exercises buildBoardConfigFromDb.
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list() { return []; } },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class { list() { return []; } listTransitions() { return []; } },
}));

import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { TEAM_FILE, LOCAL_FILE } from '../../src/main/config/board-config/config-helpers';
import type { BoardConfig } from '../../src/shared/types';

interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
  mainWindow: { isDestroyed(): boolean; webContents: { send: (channel: string, ...args: unknown[]) => void } } | null;
  isWritingBack: boolean;
  lastTeamContentHash: string | null;
  onFileChanged(projectId: string, source: 'team' | 'local'): void;
  loadTeamConfigForPath(projectPath: string): BoardConfig | null;
}

describe('board-config-manager read cache', () => {
  let tempDir: string;
  let readSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-cache-'));
    readSpy = vi.spyOn(fs, 'readFileSync');
  });

  afterEach(() => {
    readSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Count readFileSync calls that target the two board-config files. */
  function boardConfigReadCount(): number {
    return readSpy.mock.calls.filter((call) => {
      const target = String(call[0]);
      return target.endsWith(TEAM_FILE) || target.endsWith(LOCAL_FILE);
    }).length;
  }

  function teamConfig(defaultBaseBranch: string): object {
    return {
      version: 1,
      columns: [{ id: 'lane-1', name: 'To Do' }],
      actions: [],
      transitions: [],
      defaultBaseBranch,
    };
  }

  function seedManager(options: { localOverrides?: object } = {}) {
    fs.writeFileSync(path.join(tempDir, TEAM_FILE), JSON.stringify(teamConfig('main'), null, 2));
    if (options.localOverrides) {
      fs.writeFileSync(path.join(tempDir, LOCAL_FILE), JSON.stringify(options.localOverrides, null, 2));
    }
    const manager = new BoardConfigManager({ ephemeral: false });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'proj-1';
    internals.activeProjectPath = tempDir;
    internals.mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    return { manager, internals };
  }

  it('reads both files once, then serves repeated getDefaultBaseBranch() from the memo', () => {
    const { manager } = seedManager();

    expect(manager.getDefaultBaseBranch()).toBe('main');
    // First read: one attempt per file (team present, local missing -> null cached).
    expect(boardConfigReadCount()).toBe(2);

    manager.getDefaultBaseBranch();
    manager.getDefaultBaseBranch();
    manager.getEffectiveConfig();
    expect(boardConfigReadCount()).toBe(2);
  });

  it('serves getShortcuts() from the same memo', () => {
    const { manager } = seedManager();
    manager.getDefaultBaseBranch();
    const readsAfterFirst = boardConfigReadCount();

    manager.getShortcuts();

    expect(boardConfigReadCount()).toBe(readsAfterFirst);
  });

  it('re-reads after onFileChanged (external edit) and returns the new value', () => {
    const { manager, internals } = seedManager();
    expect(manager.getDefaultBaseBranch()).toBe('main');

    fs.writeFileSync(path.join(tempDir, TEAM_FILE), JSON.stringify(teamConfig('release/v2'), null, 2));
    internals.onFileChanged('proj-1', 'team');

    expect(manager.getDefaultBaseBranch()).toBe('release/v2');
  });

  it('invalidates even when onFileChanged returns via a suppression fast-path', () => {
    const { manager, internals } = seedManager();
    expect(manager.getDefaultBaseBranch()).toBe('main');

    fs.writeFileSync(path.join(tempDir, TEAM_FILE), JSON.stringify(teamConfig('develop'), null, 2));
    // Watcher fires during the app's own write-back window: the reconcile
    // event is suppressed, but the memo must STILL be dropped.
    internals.isWritingBack = true;
    internals.onFileChanged('proj-1', 'team');
    internals.isWritingBack = false;

    expect(manager.getDefaultBaseBranch()).toBe('develop');
  });

  it('setDefaultBaseBranch invalidates so the next read returns the written value', () => {
    const { manager } = seedManager();
    expect(manager.getDefaultBaseBranch()).toBe('main');

    manager.setDefaultBaseBranch('release/x');

    expect(manager.getDefaultBaseBranch()).toBe('release/x');
  });

  it('never caches or serves non-active paths', () => {
    const { manager, internals } = seedManager();
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-other-'));
    try {
      fs.writeFileSync(path.join(otherDir, TEAM_FILE), JSON.stringify(teamConfig('other-branch'), null, 2));

      // Prime the active-path memo.
      expect(manager.getDefaultBaseBranch()).toBe('main');
      const readsAfterActive = boardConfigReadCount();

      // Non-active path: every call re-reads (no memoization)...
      expect(internals.loadTeamConfigForPath(otherDir)?.defaultBaseBranch).toBe('other-branch');
      expect(internals.loadTeamConfigForPath(otherDir)?.defaultBaseBranch).toBe('other-branch');
      expect(boardConfigReadCount()).toBe(readsAfterActive + 2);

      // ...and never clobbers the active project's memo.
      expect(manager.getDefaultBaseBranch()).toBe('main');
      expect(boardConfigReadCount()).toBe(readsAfterActive + 2);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('setShortcuts invalidates so the next getShortcuts() reflects the write', () => {
    const { manager } = seedManager();

    // Prime the memo: the on-disk team config has no shortcuts field yet.
    expect(manager.getShortcuts()).toEqual([]);

    manager.setShortcuts(
      [{ id: 'shortcut-1', label: 'Open in VS Code', command: 'code "{{cwd}}"' }],
      'team',
    );

    const shortcuts = manager.getShortcuts();
    expect(shortcuts).toHaveLength(1);
    expect(shortcuts[0]).toMatchObject({ id: 'shortcut-1', label: 'Open in VS Code', source: 'team' });
  });

  it('writeBackForProject invalidates the ACTIVE project cache so the next read reflects the write', () => {
    const { manager } = seedManager();

    // Prime the memo with the original on-disk team config (one column).
    expect(manager.loadTeamConfig()?.columns).toEqual([{ id: 'lane-1', name: 'To Do' }]);

    // Write-back for the ACTIVE project: the mocked SwimlaneRepository has no
    // lanes, so the DB-derived write replaces columns on disk with [].
    manager.writeBackForProject('proj-1', tempDir);

    expect(manager.loadTeamConfig()?.columns).toEqual([]);
  });

  it('applyFileChange invalidates so a subsequent read reflects the external edit', () => {
    const { manager } = seedManager();

    // Both the initial and edited team files are deliberately schema-invalid
    // (no columns) so applyConfig's downstream applyBoardConfigToDb always
    // short-circuits on validateBoardConfig before touching the DB. This
    // isolates the assertion to pure read-memo invalidation, regardless of
    // which version of the file the DB-reconcile step happened to read.
    fs.writeFileSync(
      path.join(tempDir, TEAM_FILE),
      JSON.stringify({ version: 1, columns: [], actions: [], transitions: [], defaultBaseBranch: 'before-edit' }, null, 2),
    );
    expect(manager.getDefaultBaseBranch()).toBe('before-edit');

    // Simulate an external edit (a teammate's commit pulled on this machine).
    fs.writeFileSync(
      path.join(tempDir, TEAM_FILE),
      JSON.stringify({ version: 1, columns: [], actions: [], transitions: [], defaultBaseBranch: 'after-edit' }, null, 2),
    );

    manager.applyFileChange('proj-1', tempDir);

    expect(manager.getDefaultBaseBranch()).toBe('after-edit');
  });

  it('serves distinct instances: mutating one result never affects the next', () => {
    const { manager } = seedManager();

    const first = manager.getEffectiveConfig();
    const second = manager.getEffectiveConfig();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    expect(first!.columns[0]).not.toBe(second!.columns[0]);

    // Consumers mutate their copies (applyBoardConfigToDb splices in place);
    // the cached instance must never leak.
    first!.columns[0].name = 'MUTATED';
    first!.columns.push({ id: 'lane-injected', name: 'Injected' } as never);

    const third = manager.getEffectiveConfig();
    expect(third!.columns).toHaveLength(1);
    expect(third!.columns[0].name).toBe('To Do');
  });
});
