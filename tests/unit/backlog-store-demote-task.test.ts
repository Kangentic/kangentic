/**
 * `useBacklogStore.demoteTask` stamps the project it demotes in (the
 * project-scoped-ipc rule): a demote deletes a board task, and the Agent Monitor
 * demotes a task of a project the board is not on, so the id cannot be left to
 * the ambient current project in main.
 *
 * The third argument has three meanings, and each one is pinned with the open
 * project set to a DIFFERENT id than the one under test, so a fallback that
 * ignores the argument cannot pass by coincidence:
 *   - `undefined` (omitted): the open project's id, the board surfaces' default;
 *   - an explicit id: that id, for a surface that knows better than the board;
 *   - `null`: `null`, "no project", and NOT the open project's id. A `??` where
 *     the store has `!== undefined` would read `null` as "omitted".
 *
 * The board and project stores are replaced with minimal stand-ins so the unit
 * tier does not load the board's import graph; the backlog store itself is real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BacklogDemoteInput, BacklogTask } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  currentProjectId: 'proj-open' as string | null,
  loadBoard: vi.fn(),
  addToast: vi.fn(),
  demote: vi.fn(),
}));

vi.mock('../../src/renderer/stores/board-store', () => ({
  useBoardStore: { getState: () => ({ loadBoard: mocks.loadBoard }) },
}));
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({ currentProject: mocks.currentProjectId ? { id: mocks.currentProjectId } : null }),
  },
}));
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));

import { useBacklogStore } from '../../src/renderer/stores/backlog-store';

const DEMOTE_INPUT: BacklogDemoteInput = { taskId: 'task-1' };

function makeBacklogTask(id: string): BacklogTask {
  return {
    id,
    title: 'Demoted task',
    description: '',
    priority: 0,
    labels: [],
    position: 0,
    assignee: null,
    due_date: null,
    item_type: null,
    external_id: null,
    external_source: null,
    external_url: null,
    sync_status: null,
    external_metadata: null,
    attachment_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('useBacklogStore.demoteTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentProjectId = 'proj-open';
    mocks.demote.mockImplementation(async () => makeBacklogTask('backlog-1'));
    vi.stubGlobal('window', { electronAPI: { backlog: { demote: mocks.demote } } });
    useBacklogStore.setState({ items: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards the open project id when no project id is given', async () => {
    // Red if the fallback is dropped: the IPC would carry `undefined`, and main
    // would route the demote by whichever project it last opened.
    await useBacklogStore.getState().demoteTask(DEMOTE_INPUT);

    expect(mocks.demote).toHaveBeenCalledTimes(1);
    expect(mocks.demote).toHaveBeenCalledWith(DEMOTE_INPUT, 'proj-open');
  });

  it('forwards an explicit project id over the open project', async () => {
    // Red if the argument is ignored and the open project always wins: the
    // Agent Monitor would demote a background project's task in the wrong DB.
    await useBacklogStore.getState().demoteTask(DEMOTE_INPUT, 'proj-two');

    expect(mocks.demote).toHaveBeenCalledWith(DEMOTE_INPUT, 'proj-two');
  });

  it('forwards null as null while a project is open, not as the open project', async () => {
    // Red if `projectId !== undefined ? projectId : ...` becomes `projectId ?? ...`
    // (or `||`): null would be read as omitted and 'proj-open' would go out.
    await useBacklogStore.getState().demoteTask(DEMOTE_INPUT, null);

    expect(mocks.demote).toHaveBeenCalledWith(DEMOTE_INPUT, null);
  });

  it('forwards null when nothing was given and no project is open', async () => {
    // Red if the trailing `?? null` is dropped: `undefined` would go out and the
    // preload's `projectId ?? null` contract would be left to cover for it.
    mocks.currentProjectId = null;

    await useBacklogStore.getState().demoteTask(DEMOTE_INPUT);

    expect(mocks.demote).toHaveBeenCalledWith(DEMOTE_INPUT, null);
  });

  it('passes the input through unchanged', async () => {
    // Red if the store rebuilds the payload and drops optional fields.
    const richInput: BacklogDemoteInput = { taskId: 'task-9', priority: 2, labels: ['bug'] };

    await useBacklogStore.getState().demoteTask(richInput, 'proj-two');

    expect(mocks.demote.mock.calls[0][0]).toBe(richInput);
  });

  it('returns the backlog item, appends it to the store, and reloads the board', async () => {
    // Red if the append is dropped (the backlog view would miss the new row until
    // a manual reload) or the board reload is dropped (the demoted task would
    // stay on its card).
    useBacklogStore.setState({ items: [makeBacklogTask('existing')] });

    const returned = await useBacklogStore.getState().demoteTask(DEMOTE_INPUT);

    expect(returned.id).toBe('backlog-1');
    expect(useBacklogStore.getState().items.map((item) => item.id)).toEqual(['existing', 'backlog-1']);
    expect(mocks.loadBoard).toHaveBeenCalledTimes(1);
  });

  it('leaves the store and the board alone when the demote rejects', async () => {
    // Red if the append or the reload moves ahead of the awaited IPC: a failed
    // demote would show a backlog row for a task that is still on the board.
    mocks.demote.mockImplementation(async () => {
      throw new Error('demote failed');
    });

    await expect(useBacklogStore.getState().demoteTask(DEMOTE_INPUT)).rejects.toThrow('demote failed');

    expect(useBacklogStore.getState().items).toEqual([]);
    expect(mocks.loadBoard).not.toHaveBeenCalled();
  });
});
