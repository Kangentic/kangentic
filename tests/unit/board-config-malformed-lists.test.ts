/**
 * The BoardConfigManager readers over a `kangentic.json` or
 * `kangentic.local.json` whose lists are the wrong shape.
 *
 * Same class as Sentry DESKTOP-1H: the files come from JSON.parse, so a list
 * written as `{}` reached a `for...of` and threw "is not iterable". These
 * readers run outside the reconcile (shortcuts on every board load, the default
 * base branch on every task finalization, profiles on every spawn), so a throw
 * here broke far more than the apply.
 *
 * better-sqlite3 cannot load under vitest, so the DB modules the import graph
 * pulls in are mocked (same pattern as board-config-cache.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('../../src/main/db/repositories/automation-repository', () => ({
  AutomationRepository: class { listAll() { return []; } listForColumn() { return []; } },
}));

import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { TEAM_FILE, LOCAL_FILE, BoardConfigUnreadableError } from '../../src/main/config/board-config/config-helpers';
import { IPC } from '../../src/shared/ipc-channels';

interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
  mainWindow: { isDestroyed(): boolean; webContents: { send: (channel: string, ...args: unknown[]) => void } } | null;
}

describe('board-config-manager readers over a list that is the wrong shape', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-malformed-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFiles(team: object, local?: object): BoardConfigManager {
    fs.writeFileSync(path.join(tempDir, TEAM_FILE), JSON.stringify(team));
    if (local) fs.writeFileSync(path.join(tempDir, LOCAL_FILE), JSON.stringify(local));
    return new BoardConfigManager({ ephemeral: true });
  }

  const validTeam = {
    version: 1,
    columns: [{ id: 'lane-1', name: 'To Do', role: 'todo' }],
    defaultBaseBranch: 'develop',
    shortcuts: [{ id: 's1', label: 'Open', command: 'code .' }],
    profiles: [{ id: 'p1', name: 'Heavy', columns: {} }],
  };

  it('reads the default base branch when the local file has a non-list actions', () => {
    const manager = writeFiles(validTeam, { actions: {} });

    expect(manager.getDefaultBaseBranchForPath(tempDir)).toBe('develop');
  });

  it('ignores a local shortcuts that is not a list', () => {
    const manager = writeFiles(validTeam, { shortcuts: {} });

    expect(manager.getShortcutsForPath(tempDir).map((shortcut) => shortcut.label)).toEqual(['Open']);
  });

  it('returns no shortcuts, and skips a non-object entry, when the team shortcuts are malformed', () => {
    expect(writeFiles({ ...validTeam, shortcuts: {} }).getShortcutsForPath(tempDir)).toEqual([]);
    expect(
      writeFiles({ ...validTeam, shortcuts: [null, { id: 's2', label: 'Test', command: 'npm test' }] })
        .getShortcutsForPath(tempDir)
        .map((shortcut) => shortcut.label),
    ).toEqual(['Test']);
  });

  it('returns no profiles when profiles is not a list, and skips a non-object entry', () => {
    expect(writeFiles({ ...validTeam, profiles: { heavy: {} } }).getBoardProfiles(tempDir)).toEqual([]);
    expect(
      writeFiles({ ...validTeam, profiles: [null, { id: 'p2', name: 'Light', columns: {} }] })
        .getBoardProfiles(tempDir)
        .map((profile) => profile.name),
    ).toEqual(['Light']);
  });

  it('reports a fatal warning instead of throwing when applying a team file with a non-list actions', () => {
    const manager = writeFiles({ ...validTeam, actions: {} });

    let warnings: string[] = [];
    expect(() => {
      warnings = manager.applyConfig('project-1', tempDir).warnings;
    }).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('actions');
  });
});

// A git merge conflict leaves markers in kangentic.json. The loader read that
// as "no file", so the open-time export, and every later write-back or
// settings save, replaced the conflicted file with the local database's state:
// the merge the user was in the middle of was gone, with nothing said.
describe('board-config-manager over a file that cannot be read', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-unreadable-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conflicted = '<<<<<<< HEAD\n{ "version": 1, "columns": [] }\n=======\n{ "version": 1 }\n>>>>>>> theirs\n';
  const validLocal = JSON.stringify({ shortcuts: [{ id: 's1', label: 'Mine', command: 'code .' }] });

  function attachedManager(): { manager: BoardConfigManager; send: ReturnType<typeof vi.fn> } {
    const manager = new BoardConfigManager({ ephemeral: false });
    const send = vi.fn();
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'project-1';
    internals.activeProjectPath = tempDir;
    internals.mainWindow = { isDestroyed: () => false, webContents: { send } };
    return { manager, send };
  }

  const read = (fileName: string) => fs.readFileSync(path.join(tempDir, fileName), 'utf-8');
  const write = (fileName: string, content: string) => fs.writeFileSync(path.join(tempDir, fileName), content);

  it('warns that kangentic.json could not be read instead of applying nothing in silence', () => {
    write(TEAM_FILE, conflicted);
    const { manager } = attachedManager();

    const { warnings } = manager.applyConfig('project-1', tempDir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('kangentic.json could not be read');
  });

  it('warns that kangentic.local.json could not be read, and still validates the team file', () => {
    // A team file the validator rejects keeps this test off the database.
    write(TEAM_FILE, JSON.stringify({ version: 1, columns: [] }));
    write(LOCAL_FILE, '{ "shortcuts": [ }');
    const { manager } = attachedManager();

    const { warnings } = manager.applyConfig('project-1', tempDir);

    expect(warnings[0]).toContain('kangentic.local.json could not be read');
    expect(warnings[1]).toContain('no columns defined');
  });

  it('does not export the database over a team file that cannot be read', () => {
    write(TEAM_FILE, conflicted);
    const { manager } = attachedManager();

    manager.exportFromDb();
    manager.writeBackForProject('project-1', tempDir);

    expect(read(TEAM_FILE)).toBe(conflicted);
  });

  // Refused with an error, not skipped in silence. A silent skip left every
  // caller reporting success: the profile change still reached live sessions,
  // and the MCP profile commands returned `success: true`.
  it('refuses profiles, shortcuts, and the base branch over a team file that cannot be read', () => {
    write(TEAM_FILE, conflicted);
    const { manager } = attachedManager();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => manager.setBoardProfiles([{ id: 'p1', name: 'Heavy', columns: {} }], tempDir)).toThrow(BoardConfigUnreadableError);
    expect(() => manager.setShortcuts([{ id: 's1', label: 'Open', command: 'code .' }], 'team')).toThrow(BoardConfigUnreadableError);
    expect(() => manager.setDefaultBaseBranch('develop')).toThrow(/kangentic\.json could not be read, so this change was not saved/);

    expect(read(TEAM_FILE)).toBe(conflicted);
  });

  it('refuses local shortcuts over a local file that cannot be read', () => {
    write(TEAM_FILE, JSON.stringify({ version: 1, columns: [{ name: 'To Do', role: 'todo' }] }));
    write(LOCAL_FILE, '{ "shortcuts": [ }');
    const { manager } = attachedManager();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => manager.setShortcuts([{ id: 's2', label: 'Test', command: 'npm test' }], 'local')).toThrow(/kangentic\.local\.json/);

    expect(read(LOCAL_FILE)).toBe('{ "shortcuts": [ }');
  });

  // Windows editors save a byte order mark, and JSON.parse rejects one. The
  // file used to read as missing and be replaced; a refusal would block every
  // save over a file with nothing wrong in it.
  it('reads and saves a kangentic.json that starts with a byte order mark', () => {
    write(TEAM_FILE, '\uFEFF' + JSON.stringify({ version: 1, columns: [{ name: 'To Do', role: 'todo' }], defaultBaseBranch: 'main' }));
    // The escape, not a literal invisible character an editor could strip.
    expect(read(TEAM_FILE).charCodeAt(0)).toBe(0xfeff);
    const { manager } = attachedManager();

    expect(manager.getDefaultBaseBranchForPath(tempDir)).toBe('main');
    manager.setDefaultBaseBranch('develop');

    const saved = JSON.parse(read(TEAM_FILE).replace(/^\uFEFF/, ''));
    expect(saved.defaultBaseBranch).toBe('develop');
    expect(saved.columns).toEqual([{ name: 'To Do', role: 'todo' }]);
  });

  // A settings save on a project with no kangentic.json writes a stub with no
  // columns. The validator rejects that as "no columns defined", and refusing
  // the export over it would block every write-back from then on.
  it('exports over a settings-save stub that has no columns', () => {
    const { manager } = attachedManager();
    manager.setDefaultBaseBranch('develop');
    expect(JSON.parse(read(TEAM_FILE)).columns).toEqual([]);

    manager.exportFromDb();

    const exported = JSON.parse(read(TEAM_FILE));
    expect(exported.defaultBaseBranch).toBe('develop');
    expect(exported._modifiedBy).toBeTypeOf('string');
    expect(exported.actions).toBeUndefined();
  });

  it('retries a write-back a Windows lock refused, then writes it', () => {
    vi.useFakeTimers();
    try {
      // `actions` is a key the export no longer writes, so a write is visible
      // as its absence. The match check ignores `_modifiedBy`.
      write(TEAM_FILE, JSON.stringify({ version: 1, columns: [], actions: [] }));
      const { manager } = attachedManager();
      const realRead = fs.readFileSync;
      let lockedReads = 1;
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]).endsWith(TEAM_FILE) && lockedReads > 0) {
          lockedReads -= 1;
          throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
        }
        return realRead(...args);
      }) as typeof fs.readFileSync);

      manager.exportFromDb();
      expect(lockedReads).toBe(0);
      expect(JSON.parse(read(TEAM_FILE)).actions).toEqual([]);

      vi.advanceTimersByTime(500);
      readSpy.mockRestore();

      expect(JSON.parse(read(TEAM_FILE)).actions).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an absolute path out of a read failure reason', () => {
    fs.mkdirSync(path.join(tempDir, TEAM_FILE));
    const { manager } = attachedManager();

    const { warnings } = manager.applyConfig('project-1', tempDir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(tempDir);
    expect(warnings[0]).toMatch(/failed with E[A-Z]+\./);
  });

  it('still creates the team file when it is missing', () => {
    const { manager } = attachedManager();

    manager.setBoardProfiles([{ id: 'p1', name: 'Heavy', columns: {} }], tempDir);

    expect(JSON.parse(read(TEAM_FILE)).profiles).toHaveLength(1);
  });

  it('still saves local shortcuts beside a readable local file', () => {
    write(TEAM_FILE, JSON.stringify({ version: 1, columns: [{ name: 'To Do', role: 'todo' }] }));
    write(LOCAL_FILE, validLocal);
    const { manager } = attachedManager();

    manager.setShortcuts([{ id: 's2', label: 'Test', command: 'npm test' }], 'local');

    expect(JSON.parse(read(LOCAL_FILE)).shortcuts.map((shortcut: { label: string }) => shortcut.label)).toEqual(['Test']);
  });

  it('pushes the open-time warnings to the renderer, tagged with the project', () => {
    const { manager, send } = attachedManager();

    manager.sendOpenWarnings('project-1', ['kangentic.json could not be read']);

    expect(send).toHaveBeenCalledWith(IPC.BOARD_CONFIG_WARNINGS, 'project-1', ['kangentic.json could not be read']);
  });

  // The push is dropped when it lands before the renderer has made the project
  // current, which is the order a launch restore and an open by folder path
  // take. The renderer fetches on becoming current, so the warnings have to be
  // stored, and stored BEFORE the push: a dropped push is then always found.
  it('keeps the open-time warnings for a fetch, stored before the push goes out', () => {
    const { manager, send } = attachedManager();
    send.mockImplementation(() => {
      expect(manager.getLastWarnings('project-1')).toEqual(['kangentic.json could not be read']);
    });

    manager.sendOpenWarnings('project-1', ['kangentic.json could not be read']);

    expect(send).toHaveBeenCalledTimes(1);
    expect(manager.getLastWarnings('project-1')).toEqual(['kangentic.json could not be read']);
    expect(manager.getLastWarnings('project-2')).toEqual([]);
  });

  it('stores the warnings even with no window to push to', () => {
    const manager = new BoardConfigManager({ ephemeral: false });

    manager.sendOpenWarnings('project-1', ['a warning']);

    expect(manager.getLastWarnings('project-1')).toEqual(['a warning']);
  });

  it('replaces the stored warnings when a fixed file is applied, so a fetch does not bring the banner back', () => {
    // A team file the validator rejects keeps this off the database.
    write(TEAM_FILE, JSON.stringify({ version: 1, columns: [] }));
    const { manager } = attachedManager();
    manager.sendOpenWarnings('project-1', ['kangentic.json could not be read']);

    const { warnings } = manager.applyFileChange('project-1', tempDir);

    expect(manager.getLastWarnings('project-1')).toEqual(warnings);
    expect(manager.getLastWarnings('project-1')[0]).toContain('no columns defined');
  });
});
