/**
 * Edges of the BoardConfigManager write refusal and its readers that the
 * malformed-lists and malformed-columns suites do not reach:
 *
 *  - the SECOND read of a settings save (`readExistingForWrite`) failing after
 *    `assertWritable`'s first read passed;
 *  - the loaders treating valid JSON that is not an object as a missing file;
 *  - the write-back lock retry budget and its error-code classification;
 *  - `applyConfig` ordering its local-file warning before the apply's warnings.
 *
 * better-sqlite3 cannot load under vitest, so the DB modules the import graph
 * pulls in are mocked (same pattern as board-config-malformed-lists.test.ts).
 * `applyBoardConfigToDb` is mocked outright so the order test controls what the
 * apply returns.
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
import { TEAM_FILE, LOCAL_FILE, BoardConfigUnreadableError } from '../../src/main/config/board-config/config-helpers';
import { pruneDeletedColumnFromProfiles } from '../../src/main/config/board-config/prune-profile-references';
import type { BoardProfile } from '../../src/shared/types';

interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
  mainWindow: { isDestroyed(): boolean; webContents: { send: (channel: string, ...args: unknown[]) => void } } | null;
}

const realReadFileSync = fs.readFileSync;

const conflicted = '<<<<<<< HEAD\n{ "version": 1, "columns": [] }\n=======\n{ "version": 1 }\n>>>>>>> theirs\n';

const validTeam = {
  version: 1,
  columns: [{ id: 'lane-1', name: 'To Do', role: 'todo' }],
  defaultBaseBranch: 'main',
};

describe('board-config-manager write refusal and reader edges', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-edges-'));
    hoisted.applyBoardConfigToDb.mockReset();
    hoisted.applyBoardConfigToDb.mockReturnValue({ warnings: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const teamPath = () => path.join(tempDir, TEAM_FILE);
  const write = (fileName: string, content: string) => fs.writeFileSync(path.join(tempDir, fileName), content);
  /** The real file content, unaffected by any readFileSync spy. */
  const readReal = (fileName: string) => realReadFileSync(path.join(tempDir, fileName), 'utf-8');

  function attachedManager(): BoardConfigManager {
    const manager = new BoardConfigManager({ ephemeral: false });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'project-1';
    internals.activeProjectPath = tempDir;
    internals.mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    return manager;
  }

  function busyError(filePath: string, code = 'EBUSY'): NodeJS.ErrnoException {
    return Object.assign(
      new Error(`${code}: resource busy or locked, open 'C:\\Users\\dev\\project\\kangentic.json' (${filePath})`),
      { code },
    );
  }

  /**
   * Make the team file's read number `failingRead` (1-based, counted from now)
   * replace its result: `outcome` is thrown if it is an Error, else returned as
   * the file content. Every other read goes to the real file system.
   */
  function failTeamReadNumber(failingRead: number, outcome: Error | string): { teamReads: () => number } {
    let teamReadCount = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith(TEAM_FILE)) {
        teamReadCount += 1;
        if (teamReadCount === failingRead) {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        }
      }
      return realReadFileSync(...args);
    }) as typeof fs.readFileSync);
    return { teamReads: () => teamReadCount };
  }

  // A settings save reads the file twice: assertWritable, then
  // readExistingForWrite. The file can change or be locked in between.
  describe('a settings save whose second read fails', () => {
    it('refuses with a code-only reason, never the raw error whose message carries the path', () => {
      write(TEAM_FILE, JSON.stringify(validTeam));
      const before = readReal(TEAM_FILE);
      const manager = attachedManager();
      const reads = failTeamReadNumber(2, busyError(teamPath()));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      let thrown: unknown;
      try {
        manager.setDefaultBaseBranch('develop');
      } catch (error) {
        thrown = error;
      }

      expect(reads.teamReads()).toBe(2);
      expect(thrown).toBeInstanceOf(BoardConfigUnreadableError);
      const message = (thrown as Error).message;
      expect(message).toContain('EBUSY');
      expect(message).not.toContain('C:\\Users\\dev');
      expect(message).not.toContain(tempDir);
      expect(readReal(TEAM_FILE)).toBe(before);
    });

    it('refuses, and does not rewrite the file, when the second read returns merge markers', () => {
      write(TEAM_FILE, JSON.stringify(validTeam));
      const before = readReal(TEAM_FILE);
      const manager = attachedManager();
      failTeamReadNumber(2, conflicted);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => manager.setDefaultBaseBranch('develop')).toThrow(BoardConfigUnreadableError);

      expect(readReal(TEAM_FILE)).toBe(before);
    });

    it('lets the profile prune on a column delete swallow it instead of failing the delete', () => {
      write(TEAM_FILE, JSON.stringify({
        ...validTeam,
        profiles: [{ id: 'p1', name: 'Heavy', columns: { 'lane-doomed': { modelOverride: 'opus' } } }],
      }));
      const before = readReal(TEAM_FILE);
      const manager = attachedManager();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // The prune reads the profiles first (one loader read, memoized), then its
      // write does assertWritable (that file's read 1) and readExistingForWrite
      // (read 2). Arm the failure only once the profiles have been read, so the
      // numbering starts at the write.
      let armedReads: { teamReads: () => number } | null = null;
      const accessors = {
        getBoardProfiles: (): BoardProfile[] => {
          const profiles = manager.getBoardProfiles();
          armedReads = failTeamReadNumber(2, busyError(teamPath()));
          return profiles;
        },
        setBoardProfiles: (profiles: BoardProfile[]) => manager.setBoardProfiles(profiles),
      };

      let result: { removedEntries: number; clearedPlanExitTargets: number } | undefined;
      expect(() => {
        result = pruneDeletedColumnFromProfiles(accessors, { columnId: 'lane-doomed', columnName: 'Doomed' });
      }).not.toThrow();

      expect(armedReads).not.toBeNull();
      expect(armedReads!.teamReads()).toBe(2);
      expect(result).toEqual({ removedEntries: 0, clearedPlanExitTargets: 0 });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Deleted column left in Board Profiles'),
        expect.stringContaining('EBUSY'),
      );
      expect(readReal(TEAM_FILE)).toBe(before);
    });
  });

  // parseConfigObject throws on valid JSON that is not an object, and the
  // memoized reader turns the throw into null, so the file reads as missing.
  describe('loaders over valid JSON that is not an object', () => {
    it('reads a team file holding an array as missing', () => {
      write(TEAM_FILE, '[]');
      const manager = attachedManager();

      expect(manager.loadTeamConfig()).toBeNull();
      expect(manager.getEffectiveConfig()).toBeNull();
    });

    it('ignores a local file holding a string and still returns the team config', () => {
      write(TEAM_FILE, JSON.stringify(validTeam));
      write(LOCAL_FILE, '"x"');
      const manager = attachedManager();

      expect(manager.loadLocalOverrides()).toBeNull();
      let effective: ReturnType<BoardConfigManager['getEffectiveConfig']> = null;
      expect(() => { effective = manager.getEffectiveConfig(); }).not.toThrow();
      expect(effective).not.toBeNull();
      expect(effective).toEqual(manager.loadTeamConfig());
      expect(effective!.defaultBaseBranch).toBe('main');
      expect(effective!.columns.map((column) => column.name)).toEqual(['To Do']);
    });
  });

  // doWriteBack retries a transient lock code WRITE_BACK_LOCK_RETRIES (3) times,
  // WRITE_BACK_LOCK_RETRY_MS (500) apart, then skips with a warning.
  describe('write-back lock retries', () => {
    // `actions` is a key the export no longer writes, so a completed write is
    // visible as its absence.
    const staleTeam = JSON.stringify({ version: 1, columns: [], actions: [] });

    function teamReadsThatAlwaysFail(code: string): { teamReads: () => number } {
      let teamReadCount = 0;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]).endsWith(TEAM_FILE)) {
          teamReadCount += 1;
          throw busyError(String(args[0]), code);
        }
        return realReadFileSync(...args);
      }) as typeof fs.readFileSync);
      return { teamReads: () => teamReadCount };
    }

    const skipWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
      warn.mock.calls.filter((call) => String(call[0]).includes('Write-back skipped'));

    it('gives up after the initial read plus three retries, warns once, and leaves no timer pending', () => {
      vi.useFakeTimers();
      write(TEAM_FILE, staleTeam);
      const manager = attachedManager();
      const reads = teamReadsThatAlwaysFail('EBUSY');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      manager.exportFromDb();
      expect(reads.teamReads()).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(4 * 500);

      expect(reads.teamReads()).toBe(4);
      expect(skipWarnings(warn)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);

      // Nothing is left to fire a fifth attempt.
      vi.advanceTimersByTime(10_000);
      expect(reads.teamReads()).toBe(4);
      expect(readReal(TEAM_FILE)).toBe(staleTeam);
    });

    it.each(['EBUSY', 'EPERM', 'EAGAIN'])('retries once after a single %s, then writes', (code) => {
      vi.useFakeTimers();
      write(TEAM_FILE, staleTeam);
      const manager = attachedManager();
      const reads = failTeamReadNumber(1, busyError(teamPath(), code));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      manager.exportFromDb();
      // Refused for now: the lock is retried, not skipped.
      expect(JSON.parse(readReal(TEAM_FILE)).actions).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);
      expect(skipWarnings(warn)).toHaveLength(0);

      vi.advanceTimersByTime(500);

      expect(reads.teamReads()).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(readReal(TEAM_FILE)).actions).toBeUndefined();
      expect(skipWarnings(warn)).toHaveLength(0);
    });

    it.each(['EACCES', 'EISDIR'])('skips at once on a non-transient %s, with no retry timer and no write', (code) => {
      vi.useFakeTimers();
      write(TEAM_FILE, staleTeam);
      const manager = attachedManager();
      const reads = teamReadsThatAlwaysFail(code);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      manager.exportFromDb();

      expect(reads.teamReads()).toBe(1);
      expect(skipWarnings(warn)).toHaveLength(1);
      expect(String(skipWarnings(warn)[0][0])).toContain(code);
      expect(vi.getTimerCount()).toBe(0);
      expect(readReal(TEAM_FILE)).toBe(staleTeam);
    });
  });

  // An unreadable local file is dropped by the loader, so the team file applies
  // alone, and the reason it was dropped leads the returned warnings.
  describe('applyConfig with a readable team file and an unreadable local file', () => {
    it('lists the local file warning first, then the warnings the apply returned', () => {
      write(TEAM_FILE, JSON.stringify(validTeam));
      write(LOCAL_FILE, conflicted);
      hoisted.applyBoardConfigToDb.mockReturnValue({ warnings: ['from the apply'] });
      const manager = attachedManager();

      const { warnings } = manager.applyConfig('project-1', tempDir);

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('kangentic.local.json could not be read');
      expect(warnings[1]).toBe('from the apply');
      expect(hoisted.applyBoardConfigToDb).toHaveBeenCalledTimes(1);
      const [projectId, appliedConfig] = hoisted.applyBoardConfigToDb.mock.calls[0];
      expect(projectId).toBe('project-1');
      // The team file alone: the unreadable local overrides merged nothing in.
      expect(appliedConfig).toEqual(manager.loadTeamConfig());
      expect(appliedConfig.defaultBaseBranch).toBe('main');
    });
  });
});
