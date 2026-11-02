/**
 * `findTaskByWorktreePath`: which task a worktree belongs to, read from the
 * task rows in a config dir's databases.
 *
 * The number comes from the task's row, never from the folder's name, because a
 * worktree folder is a display number, a legacy `<slug>-<id8>` name or the
 * `spare_<8 hex>` folder of an adopted spare, and only the row knows the number
 * for all three. The lookup order is pinned here with a decoy beside every
 * expected row, so that reordering or dropping a step returns the decoy rather
 * than the same answer by luck.
 *
 * better-sqlite3 is built for Electron's ABI and may not load under vitest's
 * Node, so it is mocked with a fake that routes by SQL to canned rows, the same
 * approach as `preview-task-title.test.ts`. The fake hands back exactly the
 * columns each query selects, like the real driver, and does NOT check that the
 * database file exists: that check belongs to the module, so the placeholder
 * files this test touches are the only thing deciding whether the module
 * reaches the fake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hoisted mutable state the fake driver reads and writes at call time.
const mockState = vi.hoisted(() => ({
  projectsRows: [] as Array<{ id: string; path: string }>,
  // `displayId` (not `display_id`): the module's SQL aliases the column, so these
  // canned rows carry the shape better-sqlite3 would hand back after the alias.
  tasksRows: [] as Array<{ id: string; title: string; displayId: number | null; worktreePath: string | null }>,
  throwOnOpen: false,
  opened: [] as Array<{ databasePath: string; options: unknown }>,
  closedCount: 0,
}));

vi.mock('better-sqlite3', () => {
  class FakeStatement {
    constructor(private readonly sql: string) {}

    all(): unknown[] {
      if (this.sql.includes('FROM projects')) return mockState.projectsRows;
      if (this.sql.includes('FROM tasks') && this.sql.includes('worktree_path IS NOT NULL')) {
        return mockState.tasksRows
          .filter((task) => task.worktreePath !== null)
          .map((task) => ({ displayId: task.displayId, title: task.title, worktree_path: task.worktreePath }));
      }
      return [];
    }

    get(boundArgument?: unknown): unknown {
      if (this.sql.includes('FROM tasks') && this.sql.includes('display_id = ?')) {
        const match = mockState.tasksRows.find((task) => task.displayId === boundArgument);
        return match ? { displayId: match.displayId, title: match.title } : undefined;
      }
      if (this.sql.includes('FROM tasks') && this.sql.includes('LIKE')) {
        const prefix = String(boundArgument).replace(/%$/, '');
        const match = mockState.tasksRows.find((task) => task.id.startsWith(prefix));
        return match ? { displayId: match.displayId, title: match.title } : undefined;
      }
      return undefined;
    }
  }

  class FakeDatabase {
    constructor(databasePath: string, options?: unknown) {
      mockState.opened.push({ databasePath, options });
      if (mockState.throwOnOpen) throw new Error('simulated open failure');
    }

    prepare(sql: string): FakeStatement {
      return new FakeStatement(sql);
    }

    close(): void {
      mockState.closedCount += 1;
    }
  }

  return { default: FakeDatabase };
});

import { findTaskByWorktreePath } from '../../src/main/worktree-task-lookup';
import { isSamePath } from '../../src/shared/paths';

const PROJECT_ID = 'project-under-test';

let configDir: string;
let projectRoot: string;

/** Touch placeholder DB files so the module's own existence guards pass. */
function touchDbFiles(globalDb: boolean, projectDb: boolean): void {
  if (globalDb) fs.writeFileSync(path.join(configDir, 'index.db'), '');
  if (projectDb) {
    fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'projects', `${PROJECT_ID}.db`), '');
  }
}

function worktreePathFor(folderName: string): string {
  return path.join(projectRoot, '.kangentic', 'worktrees', folderName);
}

function addTask(task: { id: string; title: string; displayId: number | null; worktreePath?: string | null }): void {
  mockState.tasksRows.push({ ...task, worktreePath: task.worktreePath ?? null });
}

/** The project is registered under the temp root and both databases exist. */
function registerProject(): void {
  mockState.projectsRows = [{ id: PROJECT_ID, path: projectRoot }];
  touchDbFiles(true, true);
}

function openedPaths(): string[] {
  return mockState.opened.map((entry) => entry.databasePath);
}

beforeEach(() => {
  // Real paths, so the project root a row stores and the one the module derives
  // from the worktree path agree on any platform.
  configDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-task-lookup-config-')));
  projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-task-lookup-root-')));
  mockState.projectsRows = [];
  mockState.tasksRows = [];
  mockState.throwOnOpen = false;
  mockState.opened = [];
  mockState.closedCount = 0;
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('findTaskByWorktreePath: the row that records the path', () => {
  it('wins over a numeric folder that is named for another task\'s display number', () => {
    // Folder `566` is a number, but the task at that path is #612. Task #566
    // exists too, so a lookup that read the folder name first would answer 566.
    registerProject();
    addTask({ id: 'aaaaaaaa-0000-0000-0000-000000000566', title: 'Task five six six', displayId: 566 });
    addTask({
      id: 'bbbbbbbb-0000-0000-0000-000000000612',
      title: 'Task six one two',
      displayId: 612,
      worktreePath: worktreePathFor('566'),
    });

    expect(findTaskByWorktreePath(configDir, worktreePathFor('566'))).toEqual({
      displayId: 612,
      title: 'Task six one two',
    });
  });

  it('resolves an adopted spare folder, whose name carries no number, through its row', () => {
    const folder = 'spare_0a1b2c3d';
    registerProject();
    addTask({
      id: 'cccccccc-0000-0000-0000-000000000012',
      title: 'Other task',
      displayId: 12,
      worktreePath: worktreePathFor('12'),
    });
    addTask({
      id: 'dddddddd-0000-0000-0000-000000000612',
      title: 'Adopted a spare',
      displayId: 612,
      worktreePath: worktreePathFor(folder),
    });

    expect(findTaskByWorktreePath(configDir, worktreePathFor(folder))).toEqual({
      displayId: 612,
      title: 'Adopted a spare',
    });
  });

  it('resolves the same task from a path inside the worktree', () => {
    // The spare folder has no number and no id prefix to fall back on, so only
    // the row can answer, and only if the module cut the path down to the
    // worktree's own folder before comparing it with the row.
    const folder = 'spare_0a1b2c3d';
    registerProject();
    addTask({
      id: 'cccccccc-0000-0000-0000-000000000012',
      title: 'Other task',
      displayId: 12,
      worktreePath: worktreePathFor('12'),
    });
    addTask({
      id: 'dddddddd-0000-0000-0000-000000000612',
      title: 'Adopted a spare',
      displayId: 612,
      worktreePath: worktreePathFor(folder),
    });

    expect(findTaskByWorktreePath(configDir, path.join(worktreePathFor(folder), 'packages', 'app'))).toEqual({
      displayId: 612,
      title: 'Adopted a spare',
    });
  });
});

describe('findTaskByWorktreePath: fallbacks when no row records the path', () => {
  it('resolves a numeric folder by display number once the task has gone through Done and lost its path', () => {
    registerProject();
    addTask({ id: 'aaaaaaaa-0000-0000-0000-000000000459', title: 'Neighbour', displayId: 459 });
    addTask({ id: 'bbbbbbbb-0000-0000-0000-000000000460', title: 'Finished task', displayId: 460 });

    expect(findTaskByWorktreePath(configDir, worktreePathFor('460'))).toEqual({
      displayId: 460,
      title: 'Finished task',
    });
  });

  it('resolves a legacy slug-and-id folder by the task id prefix, keeping a null display number', () => {
    registerProject();
    addTask({ id: '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Wrong task', displayId: 5 });
    addTask({ id: '7f45c661-4380-4499-b44b-963413c63abd', title: 'Legacy task', displayId: null });

    expect(findTaskByWorktreePath(configDir, worktreePathFor('improve-preview-dev-7f45c661'))).toEqual({
      displayId: null,
      title: 'Legacy task',
    });
  });

  it('falls through a path row with an empty title to the numeric folder\'s display number', () => {
    // The path row would answer 700 with nothing after the number. The title
    // gate sends the lookup on to the folder's own number instead.
    registerProject();
    addTask({
      id: 'aaaaaaaa-0000-0000-0000-000000000700',
      title: '',
      displayId: 700,
      worktreePath: worktreePathFor('42'),
    });
    addTask({ id: 'bbbbbbbb-0000-0000-0000-000000000042', title: 'Numeric title', displayId: 42 });

    expect(findTaskByWorktreePath(configDir, worktreePathFor('42'))).toEqual({
      displayId: 42,
      title: 'Numeric title',
    });
  });

  it('falls through a path row with an empty title to the legacy id prefix', () => {
    const folder = 'legacy-slug-0a1b2c3d';
    registerProject();
    addTask({
      id: 'eeeeeeee-0000-0000-0000-000000000701',
      title: '',
      displayId: 701,
      worktreePath: worktreePathFor(folder),
    });
    addTask({ id: '0a1b2c3d-4380-4499-b44b-963413c63abd', title: 'Legacy task', displayId: 33 });

    expect(findTaskByWorktreePath(configDir, worktreePathFor(folder))).toEqual({
      displayId: 33,
      title: 'Legacy task',
    });
  });

  it('returns null for a numeric folder whose task row has an empty title', () => {
    registerProject();
    addTask({ id: 'aaaaaaaa-0000-0000-0000-000000000042', title: '', displayId: 42 });

    expect(findTaskByWorktreePath(configDir, worktreePathFor('42'))).toBeNull();
  });

  it('returns null for a legacy folder whose task row has an empty title', () => {
    registerProject();
    addTask({ id: '7f45c661-4380-4499-b44b-963413c63abd', title: '', displayId: 8 });

    expect(findTaskByWorktreePath(configDir, worktreePathFor('improve-preview-dev-7f45c661'))).toBeNull();
  });

  it('returns null when no row matches by path, display number or id prefix', () => {
    registerProject();
    addTask({ id: 'deadbeef-0000-0000-0000-000000000000', title: 'Wrong task', displayId: 12 });

    expect(findTaskByWorktreePath(configDir, worktreePathFor('999'))).toBeNull();
    expect(findTaskByWorktreePath(configDir, worktreePathFor('improve-preview-dev-7f45c661'))).toBeNull();
    expect(findTaskByWorktreePath(configDir, worktreePathFor('spare_0a1b2c3d'))).toBeNull();
  });
});

describe('findTaskByWorktreePath: paths and databases it cannot answer for', () => {
  it('returns null for a path outside .kangentic/worktrees/ without opening a database', () => {
    registerProject();
    addTask({ id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'A task', displayId: 1 });

    expect(findTaskByWorktreePath(configDir, path.join(projectRoot, 'not', 'a', 'worktree'))).toBeNull();
    // A sibling folder that only looks similar is outside the marker too.
    expect(findTaskByWorktreePath(configDir, path.join(projectRoot, '.kangentic', 'worktrees-old', '1'))).toBeNull();
    // The marker guard answers before any database is touched.
    expect(mockState.opened).toEqual([]);
  });

  it('returns null for an empty path without opening a database', () => {
    registerProject();

    expect(findTaskByWorktreePath(configDir, '')).toBeNull();
    expect(mockState.opened).toEqual([]);
  });

  it('returns null when no registered project has the worktree\'s parent root', () => {
    mockState.projectsRows = [{ id: PROJECT_ID, path: path.join(os.tmpdir(), 'some-other-root') }];
    touchDbFiles(true, true);
    addTask({ id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'A task', displayId: 1, worktreePath: worktreePathFor('1') });

    expect(findTaskByWorktreePath(configDir, worktreePathFor('1'))).toBeNull();
    // It stopped at the global database and never went on to a project's.
    expect(openedPaths()).toHaveLength(1);
    expect(isSamePath(openedPaths()[0], path.join(configDir, 'index.db'))).toBe(true);
  });

  it('returns null when the global DB is missing, without opening anything', () => {
    mockState.projectsRows = [{ id: PROJECT_ID, path: projectRoot }];
    addTask({ id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'A task', displayId: 1, worktreePath: worktreePathFor('1') });
    // The project DB exists, so only the missing global one can explain the null.
    touchDbFiles(false, true);

    expect(findTaskByWorktreePath(configDir, worktreePathFor('1'))).toBeNull();
    expect(mockState.opened).toEqual([]);
  });

  it('returns null when the global DB matches a project but the project DB is missing', () => {
    mockState.projectsRows = [{ id: PROJECT_ID, path: projectRoot }];
    addTask({ id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'A task', displayId: 1, worktreePath: worktreePathFor('1') });
    touchDbFiles(true, false);

    expect(findTaskByWorktreePath(configDir, worktreePathFor('1'))).toBeNull();
    // The global DB was read; the project's was never opened.
    expect(openedPaths()).toHaveLength(1);
    expect(isSamePath(openedPaths()[0], path.join(configDir, 'index.db'))).toBe(true);
  });

  it('returns null instead of throwing when a database fails to open', () => {
    registerProject();
    addTask({ id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'A task', displayId: 1, worktreePath: worktreePathFor('1') });
    mockState.throwOnOpen = true;

    expect(() => findTaskByWorktreePath(configDir, worktreePathFor('1'))).not.toThrow();
    expect(findTaskByWorktreePath(configDir, worktreePathFor('1'))).toBeNull();
    // The throw came from inside the lookup, not from an early exit.
    expect(mockState.opened.length).toBeGreaterThan(0);
  });
});

describe('findTaskByWorktreePath: how it opens the databases', () => {
  it('opens the global DB and then the matching project DB, each read-only, and closes both', () => {
    registerProject();
    addTask({ id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'A task', displayId: 1, worktreePath: worktreePathFor('1') });

    expect(findTaskByWorktreePath(configDir, worktreePathFor('1'))).toEqual({ displayId: 1, title: 'A task' });

    expect(mockState.opened).toHaveLength(2);
    expect(isSamePath(mockState.opened[0].databasePath, path.join(configDir, 'index.db'))).toBe(true);
    expect(isSamePath(mockState.opened[1].databasePath, path.join(configDir, 'projects', `${PROJECT_ID}.db`))).toBe(true);
    // A window title must never write to, or create, a project's database.
    for (const entry of mockState.opened) {
      expect(entry.options).toEqual({ readonly: true, fileMustExist: true });
    }
    expect(mockState.closedCount).toBe(2);
  });
});
