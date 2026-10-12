/**
 * A workflow reload keeps every task and link object it did not change, so the
 * canvas re-renders only the cards that did (one moved card used to repaint all
 * 100). It must never keep an object whose contents changed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { WorkflowDetail, WorkflowSummary, WorkflowViewTask } from '../../src/shared/types';

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: null }) },
}));
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

const { shareUnchanged, shareSummaries } = await import('../../src/renderer/stores/workflow-store');

function viewTask(key: string, canvasX: number | null = null): WorkflowViewTask {
  return {
    key, projectId: 'p', task: null, planned: null, title: `Task ${key}`, displayId: null, place: 'planned',
    swimlaneId: null, steps: [], canvasX, canvasY: null, unnamedBlockerCount: 0,
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

describe('summary reload sharing', () => {
  function summary(title: string, boardTasks: WorkflowSummary['boardTasks']): WorkflowSummary {
    return {
      workflow: { ...detail('w', []).workflow, title, state: 'running' },
      taskCount: 3, doneCount: 0, inProgressCount: 1, queuedCount: 1, blockedCount: 1, boardTasks,
    };
  }

  it('keeps the workflow row and each card\'s facts that did not change', () => {
    const before = summary('Usage budgets', {
      a: { waitingFor: [], humanGateTargetId: null, hasLinks: true },
      b: { waitingFor: ['#1'], humanGateTargetId: null, hasLinks: true },
    });
    const [after] = shareSummaries([before], [summary('Usage budgets', {
      a: { waitingFor: [], humanGateTargetId: 'lane-4', hasLinks: true },
      b: { waitingFor: ['#1'], humanGateTargetId: null, hasLinks: true },
    })]);
    expect(after.workflow).toBe(before.workflow);
    expect(after.boardTasks.a).not.toBe(before.boardTasks.a);
    expect(after.boardTasks.a.humanGateTargetId).toBe('lane-4');
    expect(after.boardTasks.b).toBe(before.boardTasks.b);
  });

  it('takes a renamed workflow\'s new row', () => {
    const before = summary('Usage budgets', {});
    const [after] = shareSummaries([before], [summary('Usage caps', {})]);
    expect(after.workflow).not.toBe(before.workflow);
    expect(after.workflow.title).toBe('Usage caps');
  });
});
