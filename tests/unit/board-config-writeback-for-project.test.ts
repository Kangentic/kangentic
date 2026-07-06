/**
 * Unit coverage for BoardConfigManager.writeBackForProject - the project-scoped
 * write-back used by the MCP command path (kangentic_update_column). Unlike the
 * debounced, active-only writeBack(), this must persist an ARBITRARY project's
 * DB state to its kangentic.json, so a tool call targeting a project other than
 * the one open in the UI still round-trips team-shared column fields.
 *
 * better-sqlite3 cannot load under vitest, so the DB + repositories the
 * build/apply import graph pulls in are mocked (same pattern as
 * board-config-onfilechange.test.ts). build-config and atomic-write are also
 * mocked so the test asserts doWriteBack's control flow (which project, whether
 * it writes, active-state guarding) via spies rather than real fs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));

vi.mock('../../src/main/config/board-config/build-config', () => ({
  buildBoardConfigFromDb: vi.fn(() => ({
    version: 1,
    columns: [{ id: 'lane-1', name: 'To Do', modelOverride: 'opus' }],
    actions: [],
    transitions: [],
    _modifiedBy: 'fingerprint-test',
  })),
}));

vi.mock('../../src/main/config/board-config/atomic-write', () => ({
  atomicWriteJson: vi.fn(() => 'hash-written'),
  contentMatchesFile: vi.fn(() => ({ matches: false, contentHash: 'hash-current' })),
  computeFingerprint: vi.fn(() => 'fingerprint-test'),
  hashFilePath: vi.fn(() => 'hash-file'),
}));

import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { buildBoardConfigFromDb } from '../../src/main/config/board-config/build-config';
import { atomicWriteJson, contentMatchesFile } from '../../src/main/config/board-config/atomic-write';
import { TEAM_FILE } from '../../src/main/config/board-config/config-helpers';

/** The private state the active-project guard reads, set directly via a typed cast. */
interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
  isWritingBack: boolean;
  lastTeamContentHash: string | null;
}

describe('BoardConfigManager.writeBackForProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The active-project write sets isWritingBack then schedules a reset via
    // setTimeout; fake timers keep that off the real event loop.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a non-active project by its own id + path (cross-project MCP path)', () => {
    const manager = new BoardConfigManager({ ephemeral: false });

    manager.writeBackForProject('proj-B', '/mock/projB');

    // The targeted project's DB is read (not the active one), and the file
    // lands in the targeted project's directory.
    expect(buildBoardConfigFromDb).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-B' }),
    );
    expect(atomicWriteJson).toHaveBeenCalledWith(
      path.join('/mock/projB', TEAM_FILE),
      expect.anything(),
    );
  });

  it("does not touch the active project's watcher-suppression state", () => {
    const manager = new BoardConfigManager({ ephemeral: false });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'proj-A';
    internals.activeProjectPath = '/mock/projA';
    internals.isWritingBack = false;
    internals.lastTeamContentHash = 'active-hash';

    manager.writeBackForProject('proj-B', '/mock/projB');

    expect(atomicWriteJson).toHaveBeenCalledWith(
      path.join('/mock/projB', TEAM_FILE),
      expect.anything(),
    );
    // proj-B has no watcher here, so writing it must not flip the active
    // project's suppression flag or clobber its last-seen content hash.
    expect(internals.isWritingBack).toBe(false);
    expect(internals.lastTeamContentHash).toBe('active-hash');
  });

  it('updates suppression bookkeeping when the target IS the active project', () => {
    const manager = new BoardConfigManager({ ephemeral: false });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'proj-A';
    internals.activeProjectPath = '/mock/projA';
    internals.isWritingBack = false;
    internals.lastTeamContentHash = null;

    manager.writeBackForProject('proj-A', '/mock/projA');

    expect(atomicWriteJson).toHaveBeenCalledWith(
      path.join('/mock/projA', TEAM_FILE),
      expect.anything(),
    );
    // Writing the active project suppresses the watcher echo: the written hash
    // is recorded and isWritingBack is set (reset later on a timer we don't run).
    expect(internals.lastTeamContentHash).toBe('hash-written');
    expect(internals.isWritingBack).toBe(true);
  });

  it('skips the write when on-disk content already matches', () => {
    vi.mocked(contentMatchesFile).mockReturnValueOnce({ matches: true, contentHash: 'same-hash' });
    const manager = new BoardConfigManager({ ephemeral: false });

    manager.writeBackForProject('proj-B', '/mock/projB');

    expect(atomicWriteJson).not.toHaveBeenCalled();
  });

  it('is a no-op for an ephemeral manager', () => {
    const manager = new BoardConfigManager({ ephemeral: true });

    manager.writeBackForProject('proj-B', '/mock/projB');

    expect(buildBoardConfigFromDb).not.toHaveBeenCalled();
    expect(atomicWriteJson).not.toHaveBeenCalled();
  });
});
