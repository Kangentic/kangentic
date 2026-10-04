/**
 * The BOARD_CONFIG_GET_LAST_WARNINGS IPC handler in board.ts. The renderer
 * fetches the warnings of the project it just made current, because the
 * open-time push is dropped when it lands before that project is current. The
 * handler has to answer for the project the renderer NAMED, not the ambient
 * current project, or a fetch for project A would return project B's banner.
 *
 * Pattern: capture the function registered via ipcMain.handle and invoke it
 * directly (same approach as board-swimlane-update-restart.test.ts). The modules
 * board.ts imports for its other channels are mocked so registration stays light.
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

describe('BOARD_CONFIG_GET_LAST_WARNINGS handler', () => {
  const warningsByProject: Record<string, string[]> = {
    'project-a': ['kangentic.json could not be read'],
  };
  const getLastWarnings = vi.fn((projectId: string) => warningsByProject[projectId] ?? []);

  beforeEach(() => {
    capturedHandlers.clear();
    getLastWarnings.mockClear();
    registerBoardHandlers({
      currentProjectId: 'project-current',
      currentProjectPath: null,
      boardConfigManager: { getLastWarnings },
    } as never);
  });

  function invoke(projectId: string): unknown {
    const handler = capturedHandlers.get(IPC.BOARD_CONFIG_GET_LAST_WARNINGS);
    if (!handler) throw new Error(`Handler for ${IPC.BOARD_CONFIG_GET_LAST_WARNINGS} was not registered`);
    return handler(null, projectId);
  }

  it('returns the manager\'s stored warnings for the project the renderer named', () => {
    expect(invoke('project-a')).toEqual(['kangentic.json could not be read']);
    expect(getLastWarnings).toHaveBeenCalledWith('project-a');
  });

  it('returns an empty list for a project with no stored warnings, not the current project\'s', () => {
    expect(invoke('project-b')).toEqual([]);
    expect(getLastWarnings).toHaveBeenCalledTimes(1);
    expect(getLastWarnings).toHaveBeenCalledWith('project-b');
  });
});
