/**
 * kangentic_save_workflow takes a planned task's labels and priority. Without
 * these tests a user loses: a label color that is saved even when the plan is
 * refused (a color for a label no task carries), a priority past the project's
 * scale that saves and then renders as "P5" on the board, and a scale check
 * that is skipped for a blank or home-named project, so the same bad priority
 * gets through by naming the board a different way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createWorkflowWithPlan = vi.fn();
const savePlan = vi.fn();
vi.mock('../../src/main/workflows/workflow-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-service')>();
  return {
    ...actual,
    savePlan: (...args: unknown[]) => savePlan(...args),
    createWorkflowWithPlan: (...args: unknown[]) => createWorkflowWithPlan(...args),
  };
});
vi.mock('../../src/main/workflows/workflow-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-runtime')>();
  return {
    ...actual,
    requireWorkflowRuntimeContext: () => ({
      projectRepo: {
        list: () => [
          { id: 'proj-1', name: 'Home' },
          { id: 'proj-2', name: 'Other' },
        ],
      },
    }),
  };
});

import { commandHandlers } from '../../src/main/agent/commands';
import { WorkflowRequestError } from '../../src/main/workflows/workflow-service';
import type { CommandContext } from '../../src/main/agent/commands/types';

const SEEDED_SCALE = '0 None, 1 Low, 2 Medium, 3 High, 4 Urgent';

const onLabelColorsChanged = vi.fn();

function contextWith(extra: Record<string, unknown> = {}): CommandContext {
  return { projectId: 'proj-1', onLabelColorsChanged, ...extra } as unknown as CommandContext;
}

function savedWorkflow() {
  return { id: 'wf-1', title: 'T', revision: 1, draft: { tasks: [{ key: 'api' }], links: [] } };
}

function saveWith(task: Record<string, unknown>, context: CommandContext = contextWith()) {
  return commandHandlers.save_workflow({ tasks: [{ key: 'api', title: 'A', ...task }] }, context);
}

beforeEach(() => {
  createWorkflowWithPlan.mockReset();
  savePlan.mockReset();
  onLabelColorsChanged.mockReset();
  createWorkflowWithPlan.mockReturnValue(savedWorkflow());
  savePlan.mockReturnValue(savedWorkflow());
});

describe('save_workflow label colors', () => {
  it('saves a label color once, after the plan saved, and the plan carries only names', async () => {
    const response = await saveWith({ labels: ['ui', { name: 'regression', color: '#f97316' }] });

    expect(response.success).toBe(true);
    const plan = createWorkflowWithPlan.mock.calls[0][3] as { tasks: Array<{ labels: string[] | null }> };
    expect(plan.tasks[0].labels).toEqual(['ui', 'regression']);
    expect(onLabelColorsChanged).toHaveBeenCalledTimes(1);
    expect(onLabelColorsChanged).toHaveBeenCalledWith({ regression: '#f97316' });
  });

  it('saves no color when the plan is refused', async () => {
    createWorkflowWithPlan.mockImplementation(() => {
      throw new WorkflowRequestError('Task 1 ("api"): refused.');
    });

    const response = await saveWith({ labels: [{ name: 'regression', color: '#f97316' }] });

    expect(response.success).toBe(false);
    expect(onLabelColorsChanged).not.toHaveBeenCalled();
  });

  it('saves no colors when every label is a plain name', async () => {
    const response = await saveWith({ labels: ['ui', 'api'] });

    expect(response.success).toBe(true);
    expect(onLabelColorsChanged).not.toHaveBeenCalled();
  });
});

describe('save_workflow priority against the project scale', () => {
  // Each way of naming the home board must be held to its scale.
  const homeBoardProjects: Array<[string, Record<string, unknown>]> = [
    ['no project', {}],
    ['an empty project', { project: '' }],
    ['a blank project', { project: '   ' }],
    ['the home project named outright', { project: 'Home' }],
  ];

  for (const [description, projectField] of homeBoardProjects) {
    it(`refuses a priority past the seeded scale for ${description}`, async () => {
      const response = await saveWith({ priority: 5, ...projectField });

      expect(response.success).toBe(false);
      expect(response.error).toContain(SEEDED_SCALE);
      expect(createWorkflowWithPlan).not.toHaveBeenCalled();
    });
  }

  it('does not hold a task on another project to the home scale', async () => {
    const response = await saveWith({ priority: 5, project: 'Other' });

    expect(response.error ?? '').not.toContain(SEEDED_SCALE);
    expect(createWorkflowWithPlan).toHaveBeenCalledTimes(1);
  });

  it('accepts a priority the project scale has, when the project has a longer scale', async () => {
    const sixLevels = ['None', 'Low', 'Medium', 'High', 'Urgent', 'Critical'].map((label) => ({ label, color: '#888888' }));
    const context = contextWith({ getBacklogDisplayConfig: () => ({ priorities: sixLevels, labelColors: {} }) });

    const response = await saveWith({ priority: 5 }, context);

    expect(response.success).toBe(true);
    expect(createWorkflowWithPlan).toHaveBeenCalledTimes(1);
  });
});
