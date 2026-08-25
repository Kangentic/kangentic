/**
 * Regression coverage for PopOutChangesRoot's (and TaskChangesDialog's) mount
 * guard: a no-worktree task (`worktree_path: null`) legitimately diffs
 * against the project checkout - ChangesPanel and the main-process
 * diff-service both already fall back to `projectPath` when `worktreePath` is
 * absent (see TaskDetailBody.tsx's `worktreePath={task.worktree_path ??
 * undefined}` wiring, which is why the embedded panel works). The two
 * detached surfaces wrongly required `worktree_path` to be truthy before
 * mounting the panel at all, so a no-worktree task's pop-out fell through to
 * the empty state even with real uncommitted changes.
 *
 * This project's vitest config has no jsdom environment and no
 * @testing-library/react dependency (see panel-error-boundary.test.ts for the
 * established rationale and pattern), so these tests call the REAL
 * production function components directly and inspect the plain React
 * element object graph (`{ type, props }`) that `React.createElement` output
 * produces - no renderer required. The Zustand store hooks these components
 * call (useProjectStore / useConfigStore / useBoardStore) use
 * `useSyncExternalStore` internally, which throws when invoked outside a real
 * React render, so they are mocked to plain selector-over-state functions:
 * the component body runs unmodified while the hooks resolve synchronously.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Task } from '../../src/shared/types';

const mockState = vi.hoisted(() => ({
  projectPath: '/mock/project' as string | null,
  defaultBaseBranch: 'main',
  tasks: [] as Task[],
}));

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: (selector: (state: { currentProject: { path: string } | null }) => unknown) =>
    selector({ currentProject: mockState.projectPath ? { path: mockState.projectPath } : null }),
}));

vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: (selector: (state: { config: { git: { defaultBaseBranch: string } } }) => unknown) =>
    selector({ config: { git: { defaultBaseBranch: mockState.defaultBaseBranch } } }),
}));

vi.mock('../../src/renderer/stores/board-store', () => ({
  useBoardStore: (selector: (state: { tasks: Task[] }) => unknown) => selector({ tasks: mockState.tasks }),
}));

import { PopOutChangesRoot } from '../../src/renderer/pop-out/roots/PopOutChangesRoot';
import { TaskChangesDialog } from '../../src/renderer/components/dialogs/TaskChangesDialog';
import { PanelErrorBoundary } from '../../src/renderer/components/PanelErrorBoundary';
import { BaseDialog } from '../../src/renderer/components/dialogs/BaseDialog';

interface ElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function isElementLike(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (isElementLike(node)) return collectText(node.props.children);
  return '';
}

function findByType(node: unknown, type: unknown): ElementLike | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  if (isElementLike(node)) {
    if (node.type === type) return node;
    return findByType(node.props.children, type);
  }
  return null;
}

/**
 * ChangesPanel is dynamically `lazy()`-imported by PopOutChangesRoot, so its
 * element's `type` is React's lazy-wrapper object, not the real ChangesPanel
 * function reference - findByType(output, ChangesPanel) can never match it.
 * Locate it instead by a prop name unique to that element in this tree.
 */
function findElementWithProp(node: unknown, propName: string): ElementLike | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementWithProp(child, propName);
      if (found) return found;
    }
    return null;
  }
  if (isElementLike(node)) {
    if (propName in node.props) return node;
    return findElementWithProp(node.props.children, propName);
  }
  return null;
}

const NO_WORKTREE_TASK: Task = {
  id: 'task-1',
  display_id: 1,
  title: 'No-worktree task',
  description: '',
  swimlane_id: 'lane-1',
  position: 0,
  agent: null,
  session_id: null,
  worktree_path: null,
  branch_name: null,
  pr_number: null,
  pr_url: null,
  pr_state: null,
  head_sha: null,
  external_id: null,
  external_source: null,
  external_url: null,
  base_branch: 'main',
  use_worktree: null,
  labels: [],
  priority: 0,
  model_override: null,
  effort_override: null,
  agent_override: null,
  permission_mode: null,
  auto_command: null,
  attachment_count: 0,
  detail_view_state: null,
  archived_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const WORKTREE_TASK: Task = { ...NO_WORKTREE_TASK, id: 'task-2', worktree_path: '/mock/worktrees/task-2' };

function resetMockState(): void {
  mockState.projectPath = '/mock/project';
  mockState.defaultBaseBranch = 'main';
  mockState.tasks = [];
}

describe('PopOutChangesRoot worktree_path guard', () => {
  it('mounts the panel (not the empty state) for a no-worktree task with a valid projectPath', () => {
    resetMockState();
    mockState.tasks = [NO_WORKTREE_TASK];

    const output = PopOutChangesRoot({ params: { taskId: NO_WORKTREE_TASK.id, projectId: 'proj-1' } });

    expect(findByType(output, PanelErrorBoundary)).not.toBeNull();
    expect(collectText(output)).not.toContain('No changes on this branch');
  });

  it('passes filePopOutParams to ChangesPanel matching the root params, so per-file diff windows resolve the right task/project', () => {
    resetMockState();
    mockState.tasks = [WORKTREE_TASK];

    const params = { taskId: WORKTREE_TASK.id, projectId: 'proj-1' };
    const output = PopOutChangesRoot({ params });

    const changesPanelElement = findElementWithProp(output, 'filePopOutParams');
    expect(changesPanelElement).not.toBeNull();
    expect(changesPanelElement?.props.filePopOutParams).toEqual({
      taskId: params.taskId,
      projectId: params.projectId,
    });
  });

  it('mounts the panel for a worktree-backed task (no regression)', () => {
    resetMockState();
    mockState.tasks = [WORKTREE_TASK];

    const output = PopOutChangesRoot({ params: { taskId: WORKTREE_TASK.id, projectId: 'proj-1' } });

    expect(findByType(output, PanelErrorBoundary)).not.toBeNull();
    expect(collectText(output)).not.toContain('No changes on this branch');
  });

  it('shows the empty state when the task lookup misses', () => {
    resetMockState();
    mockState.tasks = [];

    const output = PopOutChangesRoot({ params: { taskId: 'missing-task', projectId: 'proj-1' } });

    expect(findByType(output, PanelErrorBoundary)).toBeNull();
    expect(collectText(output)).toContain('No changes on this branch');
  });

  it('shows the empty state when projectPath is null', () => {
    resetMockState();
    mockState.projectPath = null;
    mockState.tasks = [NO_WORKTREE_TASK];

    const output = PopOutChangesRoot({ params: { taskId: NO_WORKTREE_TASK.id, projectId: 'proj-1' } });

    expect(findByType(output, PanelErrorBoundary)).toBeNull();
    expect(collectText(output)).toContain('No changes on this branch');
  });
});

describe('TaskChangesDialog worktree_path guard', () => {
  it('mounts the panel (not the empty state) for a no-worktree task with a valid projectPath', () => {
    resetMockState();

    const output = TaskChangesDialog({ task: NO_WORKTREE_TASK, onClose: () => {} });

    const dialog = findByType(output, BaseDialog);
    expect(dialog).not.toBeNull();
    expect(findByType(dialog?.props.children, PanelErrorBoundary)).not.toBeNull();
    expect(collectText(dialog?.props.children)).not.toContain('No changes on this branch');
  });

  it('shows the empty state when projectPath is null', () => {
    resetMockState();
    mockState.projectPath = null;

    const output = TaskChangesDialog({ task: NO_WORKTREE_TASK, onClose: () => {} });

    const dialog = findByType(output, BaseDialog);
    expect(findByType(dialog?.props.children, PanelErrorBoundary)).toBeNull();
    expect(collectText(dialog?.props.children)).toContain('No changes on this branch');
  });
});
