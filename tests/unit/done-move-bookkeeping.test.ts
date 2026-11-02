/**
 * Two symmetry bugs around the Done column, both found while verifying the
 * Done/archived resume guard. Neither is reachable through the UI, which is why
 * both survived: the board routes archived cards to TASK_UNARCHIVE and writes
 * suspend status optimistically, so only main-driven callers saw them.
 *
 * 1. `handleTaskMove` archived on the way INTO Done and never unarchived on the
 *    way out. MCP `move_task` therefore left the task archived in a live column:
 *    absent from every board query (`archived_at IS NULL`) while holding a
 *    worktree and, in an auto-spawn column, a running agent. That is the same
 *    "live agent with no card" state the resume guard exists to prevent. The
 *    handler's own branches are driven in task-move-clear-archived.test.ts; what
 *    is checked here is the repository method it calls, against a real SQLite.
 *
 * 2. `SessionManager.suspend` marked the session suspended, then awaited a
 *    graceful PTY shutdown (up to 1500ms for a natural exit plus 1500ms for kill
 *    propagation) BEFORE telling the renderer. The bottom panel's tab set is
 *    `status === 'running'`, so a task dragged to Done kept a dead terminal
 *    tabbed for seconds after its card was gone. Checked by running a real
 *    `suspend()` and reading what it had announced while its PTY was still open.
 *
 * Red-green: put a `swimlane_id` or `position` write into `clearArchived`, or move
 * `suspend`'s first `session-changed` emit below its `gracefulPtyShutdown` await,
 * and the matching test fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { derivePanelSessions } from '../../src/renderer/utils/panel-sessions';
import type { Session } from '../../src/shared/types';

describe('a move out of Done clears the archive flag it set on the way in', () => {
  let database: ReturnType<typeof openTestDatabase>;
  let tasks: TaskRepository;
  let laneId: string;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    laneId = new SwimlaneRepository(database).list().filter((lane) => lane.role === null)[0].id;
  });

  afterEach(() => database.close());

  it('brings an archived task back onto the board without touching its place', () => {
    tasks.create({ title: 'First', description: '', swimlane_id: laneId });
    const archived = tasks.create({ title: 'Second', description: '', swimlane_id: laneId });
    tasks.archive(archived.id);
    // The archive hides it from every board query.
    expect(tasks.list(laneId).map((task) => task.id)).not.toContain(archived.id);
    expect(tasks.getById(archived.id)?.archived_at).toBeTruthy();

    tasks.clearArchived(archived.id);

    const restored = tasks.getById(archived.id);
    expect(restored?.archived_at).toBeNull();
    // `unarchive()` rewrites swimlane_id and position, which would fight the
    // sibling reordering `move()` did earlier in the same tick.
    expect(restored?.swimlane_id).toBe(archived.swimlane_id);
    expect(restored?.position).toBe(archived.position);
    expect(tasks.list(laneId).map((task) => task.id)).toContain(archived.id);
  });

  it('leaves every other task alone', () => {
    const kept = tasks.create({ title: 'Kept', description: '', swimlane_id: laneId });
    const other = tasks.create({ title: 'Other', description: '', swimlane_id: laneId });
    tasks.archive(kept.id);
    tasks.archive(other.id);

    tasks.clearArchived(other.id);

    expect(tasks.getById(kept.id)?.archived_at).toBeTruthy();
    expect(tasks.getById(other.id)?.archived_at).toBeNull();
  });
});

describe('suspend announces before it waits, not after', () => {
  let tmpDir: string;
  let manager: SessionManager;

  function createMockPty() {
    let exitHandler: ((exitEvent: { exitCode: number }) => void) | null = null;
    const mockPty = {
      pid: 4242,
      cols: 120,
      rows: 30,
      onData: vi.fn(() => ({ dispose: () => undefined })),
      onExit: vi.fn((callback: (exitEvent: { exitCode: number }) => void) => {
        exitHandler = callback;
        return { dispose: () => { exitHandler = null; } };
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    // The mock's kill() raises no exit, so the PTY stays open until a test says it exited.
    return { mockPty, triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-done-move-'));
    manager = new SessionManager();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has told the renderer the session is suspended while its PTY is still open, and tells it again after', async () => {
    const { mockPty, triggerExit } = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId: 'task-suspend-order', command: '', cwd: tmpDir });
    const announced: string[] = [];
    manager.on('session-changed', (_sessionId: string, changed: Session) => announced.push(changed.status));

    let settled = false;
    const suspending = manager.suspend(session.id).then(() => { settled = true; });

    // The PTY has not exited, so the graceful shutdown is still waiting on it:
    // the renderer must already have heard, or it keeps a dead terminal tabbed.
    expect(settled).toBe(false);
    expect(announced).toEqual(['suspended']);

    triggerExit(0);
    // Whatever the PTY's own exit handler announced is counted by now. The
    // suspend still has its scrollback scan to await, so the announce that
    // carries the post-shutdown session (a recovered agent session id) comes after.
    const announcedByExit = announced.length;
    await suspending;

    expect(announced.length).toBeGreaterThan(announcedByExit);
    expect(announced.every((status) => status === 'suspended')).toBe(true);
    manager.remove(session.id);
  });
});

describe('the panel tab set is what makes the emit ordering matter', () => {
  function sessionWith(id: string, status: Session['status']): Session {
    return { id, taskId: `task-${id}`, projectId: 'project-1', status, transient: false } as Session;
  }

  it('lists a running session as a tab and drops a suspended or exited one', () => {
    // If this ever stops being the predicate, the ordering guarantee above is
    // guarding the wrong thing and this file should be revisited.
    const panel = derivePanelSessions({
      sessions: [sessionWith('running', 'running'), sessionWith('suspended', 'suspended'), sessionWith('exited', 'exited')],
      currentProjectId: 'project-1',
      dialogSessionIds: [],
      remoteDetailTaskIds: [],
    });

    expect(panel.visible.map((session) => session.id)).toEqual(['running']);
  });
});
