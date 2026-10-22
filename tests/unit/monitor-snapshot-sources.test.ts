/**
 * Unit tests for `monitorSnapshotSources` in
 * src/main/monitor/monitor-snapshot-sources.ts: the two reads an Agent Monitor
 * snapshot takes beyond the session registry and each project's repos.
 *
 * Covers:
 *   - a running workflow comes back as the row's { id, title, colorSlot }
 *   - a draft or paused workflow also comes back as the row's workflow
 *   - a finished workflow reads null, as the board draws no strip for one
 *   - a home project whose database is gone reads null, and is never created
 *     (getProjectDb would create, migrate and seed one)
 *   - the browser task set is the registry's own
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Workflow } from '../../src/shared/types';

const mockGetExistingProjectDb = vi.fn();
const mockGetProjectDb = vi.fn();
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (...args: unknown[]) => mockGetExistingProjectDb(...args),
  getProjectDb: (...args: unknown[]) => mockGetProjectDb(...args),
}));

const mockWorkflowsById = new Map<string, Partial<Workflow>>();
vi.mock('../../src/main/db/repositories/workflow-repository', () => ({
  WorkflowRepository: class {
    getById(id: string): Partial<Workflow> | undefined {
      return mockWorkflowsById.get(id);
    }
  },
}));

const mockTaskIds = vi.fn(() => new Set<string>());
vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: { taskIds: () => mockTaskIds() },
}));

import { monitorSnapshotSources } from '../../src/main/monitor/monitor-snapshot-sources';

describe('monitorSnapshotSources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowsById.clear();
    mockGetExistingProjectDb.mockImplementation(() => ({}));
  });

  it("reads a running workflow as the row's workflow", () => {
    mockWorkflowsById.set('workflow-1', { id: 'workflow-1', title: 'Harden the API', color_slot: 2, state: 'running' });

    expect(monitorSnapshotSources.readWorkflow('project-home', 'workflow-1')).toEqual({
      id: 'workflow-1', title: 'Harden the API', colorSlot: 2,
    });
    expect(mockGetExistingProjectDb).toHaveBeenCalledWith('project-home');
  });

  it.each(['draft', 'paused'] as const)('reads a %s workflow as its workflow, not null', (state) => {
    // Only a finished workflow draws no strip. A paused workflow still holds its
    // tasks (that is what Pause means), so the strip and the Workflow column must
    // keep naming it; a check of "anything but running" would blank them.
    mockWorkflowsById.set('workflow-1', { id: 'workflow-1', title: 'On hold', color_slot: 4, state });

    expect(monitorSnapshotSources.readWorkflow('project-home', 'workflow-1')).toEqual({
      id: 'workflow-1', title: 'On hold', colorSlot: 4,
    });
  });

  it('reads a finished workflow as null', () => {
    mockWorkflowsById.set('workflow-1', { id: 'workflow-1', title: 'Shipped', color_slot: 1, state: 'done' });

    expect(monitorSnapshotSources.readWorkflow('project-home', 'workflow-1')).toBeNull();
  });

  it('reads null for a workflow that is gone', () => {
    expect(monitorSnapshotSources.readWorkflow('project-home', 'workflow-missing')).toBeNull();
  });

  it('reads null when the home project database is gone, without creating one', () => {
    mockGetExistingProjectDb.mockImplementation(() => null);
    mockWorkflowsById.set('workflow-1', { id: 'workflow-1', title: 'Harden the API', color_slot: 2, state: 'running' });

    expect(monitorSnapshotSources.readWorkflow('project-deleted', 'workflow-1')).toBeNull();
    expect(mockGetProjectDb).not.toHaveBeenCalled();
  });

  it("returns the browser registry's task set", () => {
    mockTaskIds.mockReturnValue(new Set(['task-1']));

    expect([...monitorSnapshotSources.browserTaskIds()]).toEqual(['task-1']);
  });
});
