/**
 * workflowWireFacts (src/main/mobile-bridge/handlers/workflow-wire.ts): the
 * workflow facts a phone's board snapshot carries per task. Read from the
 * same summaries the desktop board draws from, so the lock and what a card
 * waits for cannot differ between the two.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Swimlane, Task, Workflow, WorkflowSummary } from '../../../src/shared/types';

const swimlanesList = vi.fn();
const listSummaries = vi.fn();
const workflowGetById = vi.fn();

vi.mock('../../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({ swimlanes: { list: swimlanesList } })),
}));
vi.mock('../../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));
vi.mock('../../../src/main/db/repositories/workflow-repository', () => ({
  WorkflowRepository: class {
    getById(workflowId: string): unknown {
      return workflowGetById(workflowId);
    }
  },
}));
vi.mock('../../../src/main/workflows/workflow-view-service', () => ({
  listWorkflowSummaries: (...args: unknown[]) => listSummaries(...args),
}));

import { workflowWireFacts } from '../../../src/main/mobile-bridge/handlers/workflow-wire';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function lane(id: string, position: number, role: Swimlane['role'] = null): Swimlane {
  return { id, position, role, is_archived: false, is_ghost: false } as Swimlane;
}

const LANES = [lane('todo', 0, 'todo'), lane('plan', 1), lane('exec', 2), lane('review', 3), lane('done', 4, 'done')];

function task(overrides: Partial<Task>): Task {
  return {
    id: 't-1',
    display_id: 414,
    swimlane_id: 'exec',
    workflow_id: null,
    workflow_project_id: null,
    route_start_swimlane_id: null,
    route_last_swimlane_id: null,
    skipped_swimlane_ids: [],
    ...overrides,
  } as Task;
}

function workflow(overrides: Partial<Workflow>): Workflow {
  return { id: 'wf-1', title: 'Usage budgets', state: 'running', color_slot: 3, ...overrides } as Workflow;
}

function summary(of: Workflow, boardTasks: WorkflowSummary['boardTasks']): WorkflowSummary {
  return { workflow: of, boardTasks } as WorkflowSummary;
}

const context = {} as IpcContext;

describe('workflowWireFacts', () => {
  beforeEach(() => {
    swimlanesList.mockReset().mockReturnValue(LANES);
    listSummaries.mockReset().mockReturnValue([]);
    workflowGetById.mockReset().mockReturnValue(undefined);
  });

  it('reads nothing for a board with no workflow task', () => {
    const facts = workflowWireFacts(context, 'proj-1', [task({})]);
    expect(facts.size).toBe(0);
    expect(listSummaries).not.toHaveBeenCalled();
    expect(swimlanesList).not.toHaveBeenCalled();
  });

  it('sends a running workflow task its strip, route, wait and lock', () => {
    listSummaries.mockReturnValue([
      summary(workflow({}), { 't-1': { waitingFor: [], humanGateTargetId: 'review' }, 't-2': { waitingFor: ['#414'], humanGateTargetId: null } }),
    ]);
    const facts = workflowWireFacts(context, 'proj-1', [
      task({ workflow_id: 'wf-1', skipped_swimlane_ids: ['plan'] }),
      task({ id: 't-2', display_id: 415, swimlane_id: 'todo', workflow_id: 'wf-1' }),
    ]);

    expect(facts.get('t-1')).toEqual({
      id: 'wf-1',
      title: 'Usage budgets',
      project_id: 'proj-1',
      state: 'running',
      color_slot: 3,
      route: ['exec', 'review'],
      waiting_for: [],
      lock_reason: '#414 is locked while Usage budgets runs.',
      gate_target_id: 'review',
    });
    expect(facts.get('t-2')?.waiting_for).toEqual(['#414']);
    expect(facts.get('t-2')?.route).toEqual(['plan', 'exec', 'review']);
    // One summaries read per home project, however many of its tasks are here.
    expect(listSummaries).toHaveBeenCalledTimes(1);
  });

  it('leaves a paused workflow task unlocked, since a hand may move it', () => {
    listSummaries.mockReturnValue([summary(workflow({ state: 'paused' }), { 't-1': { waitingFor: [], humanGateTargetId: null } })]);
    const facts = workflowWireFacts(context, 'proj-1', [task({ workflow_id: 'wf-1' })]);
    expect(facts.get('t-1')?.state).toBe('paused');
    expect(facts.get('t-1')?.lock_reason).toBeNull();
  });

  it('reads a task of another project\'s workflow from that home project', () => {
    listSummaries.mockImplementation((_context: IpcContext, homeId: string) => (
      homeId === 'proj-home' ? [summary(workflow({}), { 't-1': { waitingFor: [], humanGateTargetId: null } })] : []
    ));
    const facts = workflowWireFacts(context, 'proj-1', [task({ workflow_id: 'wf-1', workflow_project_id: 'proj-home' })]);
    expect(listSummaries).toHaveBeenCalledWith(context, 'proj-home');
    expect(facts.get('t-1')?.project_id).toBe('proj-home');
  });

  it('gives a finished workflow\'s task its state with no lock or wait', () => {
    workflowGetById.mockReturnValue(workflow({ state: 'done' }));
    const facts = workflowWireFacts(context, 'proj-1', [task({ swimlane_id: 'done', workflow_id: 'wf-1' })]);
    expect(facts.get('t-1')).toMatchObject({ state: 'done', lock_reason: null, waiting_for: [], gate_target_id: null });
  });

  it('sends no strip, and no failure, when the home project cannot be read', () => {
    listSummaries.mockImplementation(() => { throw new Error('database will not open'); });
    workflowGetById.mockImplementation(() => { throw new Error('database will not open'); });
    const facts = workflowWireFacts(context, 'proj-1', [task({ workflow_id: 'wf-1', workflow_project_id: 'proj-gone' })]);
    expect(facts.size).toBe(0);
  });
});
