/**
 * `closeTaskWindows` (src/main/ipc/helpers/task-windows.ts): what a terminal
 * transition closes for a task. Its pop-outs go through the manager's
 * task-scoped close, against the task's own project; its offscreen lane goes
 * too, because a Done move suspends the session rather than exiting it, and
 * only an exit destroys a lane. Where it is called, and in what order, is
 * pinned in session-leftover-reap-wiring.test.ts and mcp-project-context.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCloseForTask, mockDestroyLanesForTask, mockListOpenKeys } = vi.hoisted(() => ({
  mockCloseForTask: vi.fn((_task: { projectId: string; taskId: string }) => 0),
  mockDestroyLanesForTask: vi.fn((_taskId: string) => 0),
  mockListOpenKeys: vi.fn((): string[] => []),
}));

vi.mock('../../src/main/pop-out/pop-out-window-manager', () => ({
  popOutWindowManager: { closeForTask: mockCloseForTask, listOpenKeys: mockListOpenKeys },
}));
vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyLanesForTask: mockDestroyLanesForTask,
}));

import { closeProjectTaskWindows, closeTaskWindows } from '../../src/main/ipc/helpers/task-windows';

describe('closeTaskWindows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloseForTask.mockReturnValue(0);
    mockDestroyLanesForTask.mockReturnValue(0);
  });

  it("closes the task's pop-outs in its own project and destroys its lane", () => {
    mockCloseForTask.mockReturnValue(2);
    mockDestroyLanesForTask.mockReturnValue(1);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    closeTaskWindows('project-1', 'task-abcdef12');

    expect(mockCloseForTask).toHaveBeenCalledTimes(1);
    expect(mockCloseForTask).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-abcdef12' });
    expect(mockDestroyLanesForTask).toHaveBeenCalledWith('task-abcdef12');
    expect(logSpy).toHaveBeenCalledWith('[TASK_WINDOWS] Closed 2 pop-out(s) and 1 lane(s) for task task-abc');
    logSpy.mockRestore();
  });

  it('logs nothing when the task had no windows', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    closeTaskWindows('project-1', 'task-1');

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('still destroys the lane when no project is known, and never guesses one for the pop-outs', () => {
    closeTaskWindows(null, 'task-1');

    expect(mockCloseForTask).not.toHaveBeenCalled();
    expect(mockDestroyLanesForTask).toHaveBeenCalledWith('task-1');
  });

  it('never throws: a window that fails to close must not fail the move or delete', () => {
    mockCloseForTask.mockImplementationOnce(() => {
      throw new Error('window already gone');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => closeTaskWindows('project-1', 'task-1')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

/**
 * `closeProjectTaskWindows`: a project deleted after its folder went away is
 * deleted without reading its tasks, so the open windows' keys name them.
 */
describe('closeProjectTaskWindows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloseForTask.mockReturnValue(0);
    mockDestroyLanesForTask.mockReturnValue(0);
  });

  it("closes each of the project's tasks once, and nothing of another project or a global window", () => {
    mockListOpenKeys.mockReturnValue([
      'browser:project-1:task-1',
      'changes:project-1:task-1',
      // A file path carries ':' and '/', and must not shift the task segment.
      'changes-file:project-1:task-2:src/a:b/file.ts',
      'changes:project-2:task-3',
      'stats',
    ]);

    closeProjectTaskWindows('project-1');

    expect(mockCloseForTask.mock.calls.map(([task]) => task)).toEqual([
      { projectId: 'project-1', taskId: 'task-1' },
      { projectId: 'project-1', taskId: 'task-2' },
    ]);
    expect(mockDestroyLanesForTask.mock.calls.map(([taskId]) => taskId)).toEqual(['task-1', 'task-2']);
  });

  it('does nothing when the project has no open windows', () => {
    mockListOpenKeys.mockReturnValue(['changes:project-2:task-3', 'stats']);

    closeProjectTaskWindows('project-1');

    expect(mockCloseForTask).not.toHaveBeenCalled();
    expect(mockDestroyLanesForTask).not.toHaveBeenCalled();
  });
});
