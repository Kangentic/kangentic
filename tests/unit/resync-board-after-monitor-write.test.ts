/**
 * The policy the Agent Monitor runs after it writes a task: reload the open
 * board, drop another project's warm snapshot, or leave it to main in the
 * detached window.
 *
 * The UI tier drives the open-project branch end to end
 * (tests/ui/monitor-writes-reach-board.spec.ts). The other two cannot be seen
 * there: the warm-switch cache has no on-screen trace until a later project
 * switch, and the UI tier runs no second window. Both are pinned here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  descriptor: null as unknown,
  currentProjectId: 'proj-open' as string | null,
  loadBoard: vi.fn(),
  loadBacklog: vi.fn(),
  invalidateProject: vi.fn(),
  enqueueReload: vi.fn((_key: string, thunk: () => void) => thunk()),
}));

vi.mock('../../src/renderer/pop-out/read-descriptor', () => ({
  readPopOutDescriptor: () => mocks.descriptor,
}));
vi.mock('../../src/renderer/lib/session-update-coalescer', () => ({
  enqueueReload: mocks.enqueueReload,
}));
vi.mock('../../src/renderer/stores/board-store', () => ({
  useBoardStore: { getState: () => ({ loadBoard: mocks.loadBoard }) },
}));
vi.mock('../../src/renderer/stores/backlog-store', () => ({
  useBacklogStore: { getState: () => ({ loadBacklog: mocks.loadBacklog }) },
}));
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({ currentProject: mocks.currentProjectId ? { id: mocks.currentProjectId } : null }),
  },
}));
vi.mock('../../src/renderer/stores/project-cache', () => ({
  invalidateProject: mocks.invalidateProject,
}));

import { resyncBoardAfterMonitorWrite } from '../../src/renderer/components/monitor/resync-board-after-monitor-write';

describe('resyncBoardAfterMonitorWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.descriptor = null;
    mocks.currentProjectId = 'proj-open';
  });

  it('reloads the board and the backlog for a task of the open project, through the drag gate', () => {
    resyncBoardAfterMonitorWrite('proj-open');
    expect(mocks.enqueueReload.mock.calls.map((call) => call[0])).toEqual(['board', 'backlog']);
    expect(mocks.loadBoard).toHaveBeenCalledTimes(1);
    expect(mocks.loadBacklog).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProject).not.toHaveBeenCalled();
  });

  it('drops the warm snapshot of another project, and leaves the open board alone', () => {
    resyncBoardAfterMonitorWrite('proj-other');
    expect(mocks.invalidateProject).toHaveBeenCalledWith('proj-other');
    expect(mocks.enqueueReload).not.toHaveBeenCalled();
    expect(mocks.loadBoard).not.toHaveBeenCalled();
  });

  it('treats every row as another project while no project is open', () => {
    mocks.currentProjectId = null;
    resyncBoardAfterMonitorWrite('proj-open');
    expect(mocks.invalidateProject).toHaveBeenCalledWith('proj-open');
    expect(mocks.loadBoard).not.toHaveBeenCalled();
  });

  it('does nothing in the detached monitor window, where main pushes to the main window instead', () => {
    mocks.descriptor = { kind: 'monitor', params: {} };
    resyncBoardAfterMonitorWrite('proj-open');
    resyncBoardAfterMonitorWrite('proj-other');
    expect(mocks.enqueueReload).not.toHaveBeenCalled();
    expect(mocks.invalidateProject).not.toHaveBeenCalled();
  });
});
