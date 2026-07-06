/**
 * Unit coverage for `taskHasDescriptionContent`, the single source of truth
 * shared by the description-peek affordance gate and the description strip's
 * render guard. The function is a four-way `||` (description, saved
 * attachments, priority, labels); the existing UI spec only exercises it
 * transitively (all-false and priority-only), so the attachments-only and
 * labels-only disjuncts are never isolated. Each case below is its own
 * assertion so dropping any single `||` term turns exactly one test red.
 */
import { describe, it, expect } from 'vitest';
import { taskHasDescriptionContent } from '../../src/renderer/components/dialogs/task-detail/description-content';
import type { Task } from '../../src/shared/types';

/** A minimal, fully-populated Task; tests override only the fields under test. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    display_id: 1,
    title: 'Untitled task',
    description: '',
    swimlane_id: 'swimlane-1',
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
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    model_override: null,
    effort_override: null,
    agent_override: null,
    attachment_count: 0,
    detail_view_state: null,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('taskHasDescriptionContent', () => {
  it('returns false when description, attachments, priority, and labels are all empty', () => {
    const task = makeTask({ description: '', priority: 0, labels: [] });

    expect(taskHasDescriptionContent(task, 0)).toBe(false);
  });

  it('returns true when only the description is set', () => {
    const task = makeTask({ description: 'Fix the login redirect bug', priority: 0, labels: [] });

    expect(taskHasDescriptionContent(task, 0)).toBe(true);
  });

  it('returns true when only saved attachments are present', () => {
    const task = makeTask({ description: '', priority: 0, labels: [] });

    expect(taskHasDescriptionContent(task, 1)).toBe(true);
  });

  it('returns true when only priority is set above zero', () => {
    const task = makeTask({ description: '', priority: 1, labels: [] });

    expect(taskHasDescriptionContent(task, 0)).toBe(true);
  });

  it('returns true when only labels are present', () => {
    const task = makeTask({ description: '', priority: 0, labels: ['bug'] });

    expect(taskHasDescriptionContent(task, 0)).toBe(true);
  });

  it('defaults a missing priority and a missing labels array to absent, without throwing', () => {
    // Simulates a Task record where `priority` and `labels` are missing
    // entirely (not merely falsy) - the exact shape the `?? 0` / `?? []`
    // defaulting in taskHasDescriptionContent exists to guard against, e.g.
    // an older stored row loaded before those columns existed.
    const { priority: droppedPriority, labels: droppedLabels, ...taskShapeWithoutPriorityOrLabels } = makeTask({
      description: '',
    });
    void droppedPriority;
    void droppedLabels;
    const taskMissingPriorityAndLabels = taskShapeWithoutPriorityOrLabels as unknown as Task;

    expect(() => taskHasDescriptionContent(taskMissingPriorityAndLabels, 0)).not.toThrow();
    expect(taskHasDescriptionContent(taskMissingPriorityAndLabels, 0)).toBe(false);
  });
});
