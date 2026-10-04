/**
 * A workflow reload keeps every task and link object it did not change, so the
 * canvas re-renders only the cards that did (one moved card used to repaint all
 * 100). It must never keep an object whose contents changed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { WorkflowDetail, WorkflowViewTask } from '../../src/shared/types';

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: null }) },
}));
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

const { shareUnchanged } = await import('../../src/renderer/stores/workflow-store');

function viewTask(key: string, canvasX: number | null = null): WorkflowViewTask {
  return {
    key, projectId: 'p', task: null, planned: null, title: `Task ${key}`, displayId: null, place: 'planned',
    swimlaneId: null, steps: [], canvasX, canvasY: null,
  };
}

function detail(workflowId: string, tasks: WorkflowViewTask[], links: Array<[string, string]> = []): WorkflowDetail {
  return {
    workflow: {
      id: workflowId, title: 'Usage budgets', brief: null, source_task_id: null, state: 'draft', draft: null,
      color_slot: 1, revision: 1, created_at: '', started_at: null, finished_at: null,
    },
    homeProjectId: 'p',
    tasks,
    links: links.map(([blockerKey, blockedKey]) => ({ blockerKey, blockedKey })),
    projectNames: { p: 'kangentic' },
  };
}

describe('workflow reload sharing', () => {
  it('keeps unchanged tasks and replaces only the changed one', () => {
    const before = detail('w', [viewTask('a'), viewTask('b'), viewTask('c')], [['a', 'b']]);
    const after = shareUnchanged(before, detail('w', [viewTask('a'), viewTask('b', 400), viewTask('c')], [['a', 'b']]));
    expect(after.tasks[0]).toBe(before.tasks[0]);
    expect(after.tasks[1]).not.toBe(before.tasks[1]);
    expect(after.tasks[1].canvasX).toBe(400);
    expect(after.tasks[2]).toBe(before.tasks[2]);
    expect(after.links).toBe(before.links);
  });

  it('keeps the whole task list when nothing changed, and takes new links', () => {
    const before = detail('w', [viewTask('a'), viewTask('b')]);
    const after = shareUnchanged(before, detail('w', [viewTask('a'), viewTask('b')], [['a', 'b']]));
    expect(after.tasks).toBe(before.tasks);
    expect(after.links).toEqual([{ blockerKey: 'a', blockedKey: 'b' }]);
  });

  it('shares nothing with a different workflow', () => {
    const before = detail('w', [viewTask('a')]);
    const next = detail('other', [viewTask('a')]);
    expect(shareUnchanged(before, next)).toBe(next);
  });
});
