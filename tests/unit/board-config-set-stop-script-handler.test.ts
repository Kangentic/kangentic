/**
 * The BOARD_CONFIG_SET_STOP_SCRIPT IPC handler in board.ts. The settings row can
 * name a project that is not the open one, so the handler turns the id the
 * renderer sent into that project's path and hands the script to the board
 * config manager for that path. An id with no row is refused, not guessed at.
 *
 * Pattern: capture the function registered via ipcMain.handle and invoke it
 * directly (as board-config-last-warnings-handler.test.ts does).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(async () => '') },
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  openAttachmentFile: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/automation-run-again', () => ({
  runAutomationAgain: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/strategy-propagation', () => ({
  propagateStrategyToLiveSessions: vi.fn(),
  propagateBoardProfileChange: vi.fn(),
  buildColumnStrategyChanges: vi.fn(() => []),
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

import { registerBoardHandlers } from '../../src/main/ipc/handlers/board';
import { IPC } from '../../src/shared/ipc-channels';

describe('BOARD_CONFIG_SET_STOP_SCRIPT handler', () => {
  const OTHER_PATH = '/mock/other-project';
  const setStopScript = vi.fn();
  const getById = vi.fn((projectId: string) => (projectId === 'project-other' ? { id: projectId, path: OTHER_PATH } : undefined));

  beforeEach(() => {
    capturedHandlers.clear();
    setStopScript.mockReset();
    getById.mockClear();
    registerBoardHandlers({
      currentProjectId: 'project-current',
      currentProjectPath: '/mock/current-project',
      boardConfigManager: { setStopScript },
      projectRepo: { getById },
    } as never);
  });

  function invoke(projectId: string, script: string | null): unknown {
    const handler = capturedHandlers.get(IPC.BOARD_CONFIG_SET_STOP_SCRIPT);
    if (!handler) throw new Error(`Handler for ${IPC.BOARD_CONFIG_SET_STOP_SCRIPT} was not registered`);
    return handler(null, projectId, script);
  }

  it('writes the script for the path of the project the renderer named, not the open one\'s', () => {
    invoke('project-other', 'npm run stop');

    expect(getById).toHaveBeenCalledWith('project-other');
    expect(setStopScript).toHaveBeenCalledTimes(1);
    expect(setStopScript).toHaveBeenCalledWith(OTHER_PATH, 'npm run stop');
  });

  it('hands a cleared field on as null', () => {
    invoke('project-other', null);

    expect(setStopScript).toHaveBeenCalledWith(OTHER_PATH, null);
  });

  it('rejects an id with no project as unknown, and writes nothing', () => {
    expect(() => invoke('project-gone', 'npm run stop')).toThrow('Unknown project');
    expect(setStopScript).not.toHaveBeenCalled();
  });

  it('lets a failed write reach the renderer', () => {
    setStopScript.mockImplementation(() => { throw new Error('could not be read'); });

    expect(() => invoke('project-other', 'npm run stop')).toThrow('could not be read');
  });
});
