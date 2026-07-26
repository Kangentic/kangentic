/**
 * BoardConfigManager's Board Profile read/write path (getBoardProfiles /
 * setBoardProfiles).
 *
 * board-profile-commands.test.ts (the MCP command-handler suite) mocks
 * `context.setBoardProfiles` / `context.getBoardProfiles` entirely at the
 * CommandContext boundary, so the manager's own file I/O has no coverage
 * anywhere else:
 *   - uuid assignment for a profile lacking one (mirrors setShortcuts);
 *   - dropping the `profiles` key entirely when the array is empty, rather
 *     than persisting `"profiles": []`;
 *   - most importantly, the non-active-project write path's watcher-
 *     suppression isolation. `writeBackForProject` already guards this same
 *     contract (board-config-writeback-for-project.test.ts), but
 *     setBoardProfiles is a DISTINCT code path (direct fs.readFileSync +
 *     atomicWriteJson, not buildBoardConfigFromDb) that must uphold it
 *     independently - nothing else proves it does.
 *
 * Uses REAL fs under os.tmpdir() (mirrors board-config-cache.test.ts) rather
 * than mocking atomic-write/contentMatchesFile, since the file round-trip IS
 * the behavior under test. The DB-touching modules pulled in transitively by
 * board-config-manager.ts's build-config/apply-config imports are mocked
 * (same minimal set as board-config-cache.test.ts) so better-sqlite3 is never
 * loaded - setBoardProfiles/getBoardProfiles never call into the DB anyway.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list() { return []; } },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class { list() { return []; } listTransitions() { return []; } },
}));

import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { TEAM_FILE } from '../../src/main/config/board-config/config-helpers';
import type { BoardConfig, BoardProfile } from '../../src/shared/types';

interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
  isWritingBack: boolean;
  lastTeamContentHash: string | null;
}

function baseTeamConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    version: 1,
    columns: [{ id: 'lane-1', name: 'To Do' }],
    actions: [],
    transitions: [],
    ...overrides,
  } as BoardConfig;
}

function readTeamFile(projectDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(projectDir, TEAM_FILE), 'utf-8')) as Record<string, unknown>;
}

describe('BoardConfigManager Board Profiles', () => {
  let projectADir: string;
  let projectBDir: string;

  beforeEach(() => {
    projectADir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-profiles-a-'));
    projectBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-profiles-b-'));
    // setBoardProfiles' active-project branch schedules a 1s isWritingBack
    // reset via setTimeout; keep that off the real event loop.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(projectADir, { recursive: true, force: true });
    fs.rmSync(projectBDir, { recursive: true, force: true });
  });

  describe('getBoardProfiles', () => {
    it('returns [] when the target project has no kangentic.json', () => {
      const manager = new BoardConfigManager({ ephemeral: false });

      expect(manager.getBoardProfiles(projectADir)).toEqual([]);
    });

    it('returns [] when no projectPath is given and no project is active', () => {
      const manager = new BoardConfigManager({ ephemeral: false });

      expect(manager.getBoardProfiles()).toEqual([]);
    });

    it('reads the persisted profiles back for an explicit projectPath', () => {
      fs.writeFileSync(
        path.join(projectADir, TEAM_FILE),
        JSON.stringify(baseTeamConfig({ profiles: [{ id: 'p1', name: 'Heavy', columns: {} }] })),
      );
      const manager = new BoardConfigManager({ ephemeral: false });

      expect(manager.getBoardProfiles(projectADir)).toEqual([{ id: 'p1', name: 'Heavy', columns: {} }]);
    });
  });

  describe('setBoardProfiles', () => {
    it('assigns a uuid to a profile that lacks one and preserves an existing id', () => {
      fs.writeFileSync(path.join(projectADir, TEAM_FILE), JSON.stringify(baseTeamConfig()));
      const manager = new BoardConfigManager({ ephemeral: false });

      manager.setBoardProfiles(
        [{ name: 'Heavy', columns: {} }, { id: 'kept-id', name: 'Light', columns: {} }],
        projectADir,
      );

      const written = readTeamFile(projectADir) as { profiles: BoardProfile[] };
      expect(written.profiles).toHaveLength(2);
      expect(written.profiles[0].id).toMatch(/^[0-9a-f-]{36}$/);
      expect(written.profiles[1].id).toBe('kept-id');
    });

    it('drops the profiles key entirely when the array is empty, rather than persisting "profiles": []', () => {
      fs.writeFileSync(
        path.join(projectADir, TEAM_FILE),
        JSON.stringify(baseTeamConfig({ profiles: [{ id: 'p1', name: 'Heavy', columns: {} }] })),
      );
      const manager = new BoardConfigManager({ ephemeral: false });

      manager.setBoardProfiles([], projectADir);

      const written = readTeamFile(projectADir);
      expect(Object.prototype.hasOwnProperty.call(written, 'profiles')).toBe(false);
    });

    it("writes a NON-active project's file without touching the active project's watcher-suppression state", () => {
      fs.writeFileSync(path.join(projectADir, TEAM_FILE), JSON.stringify(baseTeamConfig()));
      fs.writeFileSync(path.join(projectBDir, TEAM_FILE), JSON.stringify(baseTeamConfig()));
      const manager = new BoardConfigManager({ ephemeral: false });
      const internals = manager as unknown as ManagerInternals;
      internals.activeProjectId = 'proj-A';
      internals.activeProjectPath = projectADir;
      internals.isWritingBack = false;
      internals.lastTeamContentHash = 'active-hash-untouched';

      manager.setBoardProfiles([{ name: 'Heavy', columns: {} }], projectBDir);

      // The write landed on project B, not A.
      const writtenB = readTeamFile(projectBDir) as { profiles: BoardProfile[] };
      expect(writtenB.profiles).toHaveLength(1);
      const writtenA = readTeamFile(projectADir) as { profiles?: BoardProfile[] };
      expect(writtenA.profiles).toBeUndefined();

      // Project B has no watcher here, so writing it must not flip the active
      // project's suppression flag or clobber its last-seen content hash.
      expect(internals.isWritingBack).toBe(false);
      expect(internals.lastTeamContentHash).toBe('active-hash-untouched');
    });

    it('updates suppression bookkeeping (isWritingBack + lastTeamContentHash) when the target IS the active project', () => {
      fs.writeFileSync(path.join(projectADir, TEAM_FILE), JSON.stringify(baseTeamConfig()));
      const manager = new BoardConfigManager({ ephemeral: false });
      const internals = manager as unknown as ManagerInternals;
      internals.activeProjectId = 'proj-A';
      internals.activeProjectPath = projectADir;
      internals.isWritingBack = false;
      internals.lastTeamContentHash = null;

      manager.setBoardProfiles([{ name: 'Heavy', columns: {} }], projectADir);

      expect(internals.isWritingBack).toBe(true);
      expect(internals.lastTeamContentHash).not.toBeNull();

      // The suppression window resets on a 1s timer.
      vi.advanceTimersByTime(1000);
      expect(internals.isWritingBack).toBe(false);
    });

    it('is a no-op when there is no active project and no explicit projectPath', () => {
      const manager = new BoardConfigManager({ ephemeral: false });

      expect(() => manager.setBoardProfiles([{ name: 'Heavy', columns: {} }])).not.toThrow();
    });
  });
});
