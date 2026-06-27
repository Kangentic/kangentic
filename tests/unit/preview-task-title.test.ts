/**
 * Unit tests for resolvePreviewTaskTitle() - recovers the original task's title
 * for a `/preview` window from the real parent project DB (the preview clones
 * never contain it).
 *
 * better-sqlite3 is compiled for Electron's Node ABI and cannot load under
 * vitest's system Node (same constraint as task-repository.test.ts), so the
 * DB is mocked and serves canned rows. The valuable logic under test is the
 * real resolver's path handling: worktrees-marker detection, the
 * `<slug>-<shortId>` task-id-prefix extraction, project-root matching, and the
 * id-prefix vs worktree_path fallback. getPlatformConfigDir() is redirected to
 * a temp dir whose placeholder DB files make fs.existsSync() pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Hoisted mutable state the mocks read at call time.
const mockState = vi.hoisted(() => ({
  configDir: '',
  projectsRows: [] as Array<{ id: string; path: string }>,
  tasksRows: [] as Array<{ id: string; title: string; worktree_path: string | null }>,
}));

vi.mock('../../src/main/config/paths', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/config/paths')>(
    '../../src/main/config/paths',
  );
  return { ...actual, getPlatformConfigDir: () => mockState.configDir };
});

// Fake better-sqlite3 Database that routes by SQL to the canned rows.
vi.mock('better-sqlite3', () => {
  class FakeStatement {
    constructor(private readonly sql: string) {}
    all() {
      if (this.sql.includes('FROM projects')) return mockState.projectsRows;
      if (this.sql.includes('FROM tasks')) return mockState.tasksRows.filter((task) => task.worktree_path !== null);
      return [];
    }
    get(boundArg?: unknown) {
      if (this.sql.includes('FROM tasks') && this.sql.includes('LIKE')) {
        const prefix = String(boundArg).replace(/%$/, '');
        return mockState.tasksRows.find((task) => task.id.startsWith(prefix));
      }
      return undefined;
    }
  }
  class FakeDatabase {
    prepare(sql: string) {
      return new FakeStatement(sql);
    }
    close() {}
  }
  return { default: FakeDatabase };
});

import { resolvePreviewTaskTitle } from '../../src/devtools/main/preview-task-title';

const PROJECT_ID = 'project-under-test';
const TASK_ID = '7f45c661-4380-4499-b44b-963413c63abd';
const SHORT_ID = TASK_ID.slice(0, 8); // 7f45c661

let projectRoot: string;

/** Touch placeholder DB files so the resolver's fs.existsSync() guards pass. */
function touchDbFiles(globalDb: boolean, projectDb: boolean): void {
  if (globalDb) fs.writeFileSync(path.join(mockState.configDir, 'index.db'), '');
  if (projectDb) {
    fs.mkdirSync(path.join(mockState.configDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(mockState.configDir, 'projects', `${PROJECT_ID}.db`), '');
  }
}

function worktreePath(folderName: string): string {
  return path.join(projectRoot, '.kangentic', 'worktrees', folderName);
}

beforeEach(() => {
  mockState.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-title-config-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-title-root-'));
  mockState.projectsRows = [];
  mockState.tasksRows = [];
});

afterEach(() => {
  fs.rmSync(mockState.configDir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('resolvePreviewTaskTitle', () => {
  it('resolves the title by task UUID prefix from the worktree folder', () => {
    mockState.projectsRows = [{ id: PROJECT_ID, path: projectRoot }];
    mockState.tasksRows = [{ id: TASK_ID, title: 'Improve /preview dev UX', worktree_path: null }];
    touchDbFiles(true, true);

    expect(resolvePreviewTaskTitle(worktreePath(`improve-preview-dev-${SHORT_ID}`))).toBe(
      'Improve /preview dev UX',
    );
  });

  it('falls back to matching the stored worktree_path when the id prefix misses', () => {
    const folder = 'custom-branch-aaaaaaaa'; // shortId "aaaaaaaa" matches no task id
    mockState.projectsRows = [{ id: PROJECT_ID, path: projectRoot }];
    mockState.tasksRows = [
      { id: 'deadbeef-0000-0000-0000-000000000000', title: 'Wrong task', worktree_path: null },
      { id: 'feedface-1111-1111-1111-111111111111', title: 'Right task', worktree_path: worktreePath(folder) },
    ];
    touchDbFiles(true, true);

    expect(resolvePreviewTaskTitle(worktreePath(folder))).toBe('Right task');
  });

  it('returns null when the path is not inside a worktrees dir', () => {
    mockState.projectsRows = [{ id: PROJECT_ID, path: projectRoot }];
    mockState.tasksRows = [{ id: TASK_ID, title: 'Improve /preview dev UX', worktree_path: null }];
    touchDbFiles(true, true);

    expect(resolvePreviewTaskTitle(path.join(projectRoot, 'not', 'a', 'worktree'))).toBeNull();
  });

  it('returns null when no project matches the parent root', () => {
    mockState.projectsRows = [{ id: PROJECT_ID, path: path.join(os.tmpdir(), 'some-other-root') }];
    mockState.tasksRows = [{ id: TASK_ID, title: 'Improve /preview dev UX', worktree_path: null }];
    touchDbFiles(true, true);

    expect(resolvePreviewTaskTitle(worktreePath(`improve-preview-dev-${SHORT_ID}`))).toBeNull();
  });

  it('returns null when no task matches by id prefix or worktree path', () => {
    mockState.projectsRows = [{ id: PROJECT_ID, path: projectRoot }];
    mockState.tasksRows = [{ id: 'deadbeef-0000-0000-0000-000000000000', title: 'Wrong task', worktree_path: null }];
    touchDbFiles(true, true);

    expect(resolvePreviewTaskTitle(worktreePath(`improve-preview-dev-${SHORT_ID}`))).toBeNull();
  });

  it('returns null on a missing global DB (graceful fallback to "Project N")', () => {
    mockState.projectsRows = [{ id: PROJECT_ID, path: projectRoot }];
    mockState.tasksRows = [{ id: TASK_ID, title: 'Improve /preview dev UX', worktree_path: null }];
    // No DB files touched -> fs.existsSync(index.db) is false.

    expect(resolvePreviewTaskTitle(worktreePath(`improve-preview-dev-${SHORT_ID}`))).toBeNull();
  });

  it('returns null for an empty worktree path', () => {
    expect(resolvePreviewTaskTitle('')).toBeNull();
  });
});
