/**
 * Regression lock for the authoring-machine hot-reload bug.
 *
 * `kangentic.json` board-config changes did not hot-reload on the machine that
 * authored the commit: a pulled file carries THIS machine's own `_modifiedBy`
 * fingerprint (stable per hostname+username and persisted in the committed
 * file), and onFileChanged used to treat that as a self-write and only reload
 * shortcuts (BOARD_CONFIG_SHORTCUTS_CHANGED), skipping the live reconcile
 * (BOARD_CONFIG_CHANGED). So the DB swimlane auto_command stayed stale until a
 * restart. The fix removes that fingerprint guard.
 *
 * These tests lock the resulting behavior:
 *   - a genuine external change (incl. a pulled own-commit) fires
 *     BOARD_CONFIG_CHANGED, never the shortcuts-only event;
 *   - the app's own write-backs are still suppressed by the two earlier
 *     filters (the isWritingBack window and the content-hash echo check).
 *
 * better-sqlite3 cannot load under vitest, so the DB + repositories that the
 * build/apply import graph pulls in are mocked. onFileChanged('team') never
 * touches the DB, so empty stubs suffice; the mocks exist only so the module
 * graph loads without the native module (same pattern as
 * board-config-parity.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));

import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { computeFingerprint, hashFilePath } from '../../src/main/config/board-config/atomic-write';
import { TEAM_FILE } from '../../src/main/config/board-config/config-helpers';
import { IPC } from '../../src/shared/ipc-channels';

type SendMock = (channel: string, ...args: unknown[]) => void;

/** The private state onFileChanged reads; set directly via a typed cast. */
interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
  mainWindow: { isDestroyed(): boolean; webContents: { send: SendMock } } | null;
  isWritingBack: boolean;
  lastTeamContentHash: string | null;
  onFileChanged(projectId: string, source: 'team' | 'local'): void;
}

describe('board-config-manager onFileChanged (team file reconcile)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-onfilechange-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedManager(fileContents: object) {
    const filePath = path.join(tempDir, TEAM_FILE);
    fs.writeFileSync(filePath, JSON.stringify(fileContents, null, 2));
    const send = vi.fn();
    const manager = new BoardConfigManager({ ephemeral: false });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'proj-1';
    internals.activeProjectPath = tempDir;
    internals.mainWindow = { isDestroyed: () => false, webContents: { send } };
    return { internals, send, filePath };
  }

  const teamConfig = (modifiedBy: string) => ({
    version: 1,
    columns: [{ id: 'lane-tests', name: 'Tests', autoCommand: '/pull-request' }],
    actions: [],
    transitions: [],
    _modifiedBy: modifiedBy,
  });

  it('fires BOARD_CONFIG_CHANGED for a pulled own-commit (own fingerprint, new content)', () => {
    // The bug case: file carries OUR fingerprint (we authored the commit) but
    // the on-disk content differs from what we last saw (a git pull replaced it).
    const { internals, send } = seedManager(teamConfig(computeFingerprint()));
    internals.isWritingBack = false;
    internals.lastTeamContentHash = 'stale-prior-hash';

    internals.onFileChanged('proj-1', 'team');

    expect(send).toHaveBeenCalledWith(IPC.BOARD_CONFIG_CHANGED, 'proj-1');
    expect(send).not.toHaveBeenCalledWith(IPC.BOARD_CONFIG_SHORTCUTS_CHANGED, 'proj-1');
  });

  it('fires BOARD_CONFIG_CHANGED for a teammate edit (different fingerprint)', () => {
    const { internals, send } = seedManager(teamConfig('teammate-device-id'));
    internals.isWritingBack = false;
    internals.lastTeamContentHash = 'stale-prior-hash';

    internals.onFileChanged('proj-1', 'team');

    expect(send).toHaveBeenCalledWith(IPC.BOARD_CONFIG_CHANGED, 'proj-1');
  });

  it('stays silent during the app own write-back (isWritingBack window)', () => {
    const { internals, send } = seedManager(teamConfig(computeFingerprint()));
    internals.isWritingBack = true;
    internals.lastTeamContentHash = 'stale-prior-hash';

    internals.onFileChanged('proj-1', 'team');

    expect(send).not.toHaveBeenCalled();
  });

  it('stays silent on a watcher echo (content hash equals last-seen)', () => {
    const { internals, send, filePath } = seedManager(teamConfig(computeFingerprint()));
    internals.isWritingBack = false;
    internals.lastTeamContentHash = hashFilePath(filePath);

    internals.onFileChanged('proj-1', 'team');

    expect(send).not.toHaveBeenCalled();
  });
});
