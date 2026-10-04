/**
 * BoardConfigManager over a kangentic.json whose shape is wrong in ways that
 * used to throw inside the loader or hide a refused write.
 *
 * Same class as Sentry DESKTOP-1H. Three contracts are pinned here:
 *
 *   1. `migrateBoardColumnFields` runs inside the loader's parse, where any throw
 *      makes the loader read the file as MISSING (and apply nothing, in silence).
 *      A `columns` that is `{}` or carries a `null` entry must reach the
 *      validator, which names the problem.
 *   2. A write-back the manager refuses (the file cannot be read) is observable:
 *      `doWriteBack` wraps its work in a try/catch, so the refusal has to log its
 *      own warning instead of vanishing into that catch.
 *   3. `unreadableReason` treats valid JSON that is not an object, and a path
 *      that exists but cannot be read as a file, as unreadable rather than
 *      missing.
 *
 * better-sqlite3 cannot load under vitest, so the DB modules the import graph
 * pulls in are mocked (same pattern as board-config-malformed-lists.test.ts).
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
import { TEAM_FILE, BoardConfigUnreadableError } from '../../src/main/config/board-config/config-helpers';
import { planColumnAutomations } from '../../src/main/config/board-config/apply-automations';
import { IPC } from '../../src/shared/ipc-channels';
import type { BoardColumnConfig } from '../../src/shared/types';

interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
  mainWindow: { isDestroyed(): boolean; webContents: { send: (channel: string, ...args: unknown[]) => void } } | null;
}

describe('board-config-manager over a columns value that is the wrong shape', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-malformed-columns-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function applyTeam(team: object): string[] {
    fs.writeFileSync(path.join(tempDir, TEAM_FILE), JSON.stringify(team));
    const manager = new BoardConfigManager({ ephemeral: true });
    let warnings: string[] = [];
    expect(() => {
      warnings = manager.applyConfig('project-1', tempDir).warnings;
    }).not.toThrow();
    return warnings;
  }

  it('reports a columns value that is not a list, instead of reading the file as missing', () => {
    const warnings = applyTeam({ version: 1, columns: {} });

    // A file read as missing applies nothing and warns about nothing, so a
    // specific message here proves the loader parsed the file.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('columns value that is not a list');
  });

  it('reports a column that is not an object, instead of reading the file as missing', () => {
    const warnings = applyTeam({ version: 1, columns: [null, { name: 'To Do', role: 'todo' }] });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('column that is not an object');
  });

  it('still migrates the legacy permission fields on the object entries of a mixed list', () => {
    // The null entry is skipped by the migration, not allowed to abort it, so the
    // file keeps loading and the object entry beside it is the one migrated.
    fs.writeFileSync(
      path.join(tempDir, TEAM_FILE),
      JSON.stringify({ version: 1, columns: [null, { name: 'To Do', role: 'todo', permissionStrategy: 'bypass-permissions' }] }),
    );
    const manager = new BoardConfigManager({ ephemeral: true });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectPath = tempDir;

    const columns = manager.loadTeamConfig()?.columns as unknown as Array<Record<string, unknown> | null> | undefined;

    expect(columns).toBeDefined();
    expect(columns?.[0]).toBeNull();
    expect(columns?.[1]?.permissionMode).toBe('bypassPermissions');
    expect(columns?.[1]).not.toHaveProperty('permissionStrategy');
  });
});

describe('board-config-manager refusing a write-back over a file that cannot be read', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-refused-writeback-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conflicted = '<<<<<<< HEAD\n{ "version": 1, "columns": [] }\n=======\n{ "version": 1 }\n>>>>>>> theirs\n';

  function attachedManager(): BoardConfigManager {
    const manager = new BoardConfigManager({ ephemeral: false });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'project-1';
    internals.activeProjectPath = tempDir;
    return manager;
  }

  function warnMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call) => call.map(String).join(' '));
  }

  // doWriteBack wraps its work in try/catch, so a refusal that is not logged at
  // the refusal itself is indistinguishable from a write that never happened.
  it('logs that the write-back was skipped and could not be read, and leaves the file as it is (exportFromDb)', () => {
    fs.writeFileSync(path.join(tempDir, TEAM_FILE), conflicted);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    attachedManager().exportFromDb();

    const refusal = warnMessages(warnSpy).filter((message) => message.includes('skipped'));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain('could not be read');
    expect(refusal[0]).toContain(TEAM_FILE);
    expect(fs.readFileSync(path.join(tempDir, TEAM_FILE), 'utf-8')).toBe(conflicted);
  });

  it('logs the same refusal for a cross-project write-back (writeBackForProject)', () => {
    fs.writeFileSync(path.join(tempDir, TEAM_FILE), conflicted);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    attachedManager().writeBackForProject('project-1', tempDir);

    const refusal = warnMessages(warnSpy).filter((message) => message.includes('skipped'));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain('could not be read');
    expect(fs.readFileSync(path.join(tempDir, TEAM_FILE), 'utf-8')).toBe(conflicted);
  });

  it('does not log a refusal for a missing file, which the export is allowed to create', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    attachedManager().exportFromDb();

    expect(warnMessages(warnSpy).filter((message) => message.includes('skipped'))).toEqual([]);
  });
});

describe('board-config-manager unreadableReason edge cases', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-unreadable-shapes-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function attachedManager(): BoardConfigManager {
    const manager = new BoardConfigManager({ ephemeral: false });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'project-1';
    internals.activeProjectPath = tempDir;
    return manager;
  }

  // Valid JSON, so the parse succeeds, but not an object: a settings save would
  // have replaced it with a near-empty config.
  it.each(['[]', 'null', '"x"'])('reads the valid JSON %s as unreadable: warns on apply and refuses to save profiles', (content) => {
    fs.writeFileSync(path.join(tempDir, TEAM_FILE), content);
    const manager = attachedManager();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { warnings } = manager.applyConfig('project-1', tempDir);
    // Refused with an error a caller can show, not skipped in silence: the
    // IPC caller toasts it and an MCP command returns it as its error.
    expect(() => manager.setBoardProfiles([{ id: 'p1', name: 'Heavy', columns: {} }], tempDir)).toThrow(BoardConfigUnreadableError);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('kangentic.json could not be read');
    expect(warnings[0]).toContain('not a JSON object');
    expect(warnSpy.mock.calls.some((call) => call.map(String).join(' ').includes('setBoardProfiles refused'))).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, TEAM_FILE), 'utf-8')).toBe(content);
  });

  // A path that exists but is not a readable file fails with EISDIR (or EPERM on
  // some Windows builds), never ENOENT, so it must not be mistaken for "missing".
  it('reports a kangentic.json that is a directory as unreadable, not missing', () => {
    fs.mkdirSync(path.join(tempDir, TEAM_FILE));
    const manager = attachedManager();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { warnings } = manager.applyConfig('project-1', tempDir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('kangentic.json could not be read');

    expect(() => {
      manager.setBoardProfiles([{ id: 'p1', name: 'Heavy', columns: {} }], tempDir);
    }).toThrow(BoardConfigUnreadableError);
    expect(warnSpy.mock.calls.some((call) => call.map(String).join(' ').includes('setBoardProfiles refused'))).toBe(true);
    expect(fs.statSync(path.join(tempDir, TEAM_FILE)).isDirectory()).toBe(true);
  });
});

// An empty file (an interrupted write, or `touch`) holds nothing to lose. It
// reads as missing, so it is neither a warning nor a refused write.
describe('board-config-manager over an empty kangentic.json', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-empty-file-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([['a zero-byte file', ''], ['a whitespace-only file', '  \n\t\n']])(
    'does not report %s as unreadable, and setBoardProfiles writes a valid team file over it',
    (_label, content) => {
      fs.writeFileSync(path.join(tempDir, TEAM_FILE), content);
      const manager = new BoardConfigManager({ ephemeral: false });
      const internals = manager as unknown as ManagerInternals;
      internals.activeProjectId = 'project-1';
      internals.activeProjectPath = tempDir;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { warnings } = manager.applyConfig('project-1', tempDir);
      manager.setBoardProfiles([{ id: 'p1', name: 'Heavy', columns: {} }], tempDir);

      expect(warnings.filter((warning) => warning.includes('could not be read'))).toEqual([]);
      expect(warnSpy.mock.calls.some((call) => call.map(String).join(' ').includes('skipped'))).toBe(false);
      const written = JSON.parse(fs.readFileSync(path.join(tempDir, TEAM_FILE), 'utf-8')) as { profiles?: Array<{ id: string }> };
      expect(written.profiles?.map((profile) => profile.id)).toEqual(['p1']);
    },
  );
});

describe('planColumnAutomations over a legacy autoCommand that is not a string', () => {
  it('does not throw on a numeric autoCommand, and plans no rows', () => {
    const column = { name: 'Planning', autoCommand: 5 } as unknown as BoardColumnConfig;

    let plan: ReturnType<typeof planColumnAutomations> | undefined;
    expect(() => {
      plan = planColumnAutomations(column);
    }).not.toThrow();

    expect(plan?.rows).toEqual([]);
  });

  it('does not throw on an object autoCommand, and plans no rows', () => {
    const column = { name: 'Planning', autoCommand: {} } as unknown as BoardColumnConfig;

    expect(planColumnAutomations(column).rows).toEqual([]);
  });

  it('still turns a string autoCommand into one send_message row', () => {
    const plan = planColumnAutomations({ name: 'Planning', autoCommand: '  /plan  ' } as BoardColumnConfig);

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].type).toBe('send_message');
    expect(plan.rows[0].trigger).toBe('enter');
    expect(plan.rows[0].config).toMatchObject({ message: '/plan' });
  });
});

describe('board-config-manager sendOpenWarnings without a live window', () => {
  it('is a no-op when there is no main window', () => {
    const manager = new BoardConfigManager({ ephemeral: true });

    expect(() => manager.sendOpenWarnings('project-1', ['kangentic.json could not be read'])).not.toThrow();
  });

  it('sends nothing, and does not throw, when the main window is destroyed', () => {
    const manager = new BoardConfigManager({ ephemeral: true });
    const send = vi.fn();
    (manager as unknown as ManagerInternals).mainWindow = { isDestroyed: () => true, webContents: { send } };

    expect(() => manager.sendOpenWarnings('project-1', ['kangentic.json could not be read'])).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the warnings when the main window is alive (control for the two cases above)', () => {
    const manager = new BoardConfigManager({ ephemeral: true });
    const send = vi.fn();
    (manager as unknown as ManagerInternals).mainWindow = { isDestroyed: () => false, webContents: { send } };

    manager.sendOpenWarnings('project-1', ['w']);

    expect(send).toHaveBeenCalledWith(IPC.BOARD_CONFIG_WARNINGS, 'project-1', ['w']);
  });
});
