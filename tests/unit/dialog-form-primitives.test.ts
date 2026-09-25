/**
 * Unit coverage for three of the new shared dialog primitives from the
 * New/Edit Task dialog presentation refactor: `Field`'s error-wins-over-hint
 * precedence, `DialogFooterActions`'s submit-vs-button `type` ternary, and
 * `WorktreePlacementControl`'s blocked-state mapping onto the shared
 * `SegmentedControl`. All three are hookless function
 * components, so - following the established pattern in
 * `panel-error-boundary.test.ts` (this project's vitest config has no jsdom
 * environment and no @testing-library/react dependency) - they are called
 * directly as plain functions and their real `React.createElement` output
 * (`{ type, props }`) is walked without a renderer.
 *
 * `TaskBranchRow`'s `showWorktree` prop and `PriorityLabelsRow` are
 * deliberately NOT covered here: `TaskBranchRow` renders correctly for any
 * `showWorktree` value passed to it, so a unit test on the component would
 * pass unchanged even if the call site computed the wrong boolean (e.g.
 * `showWorktree={!!task.worktree_path}` inverted). That risk lives at the
 * call site in `TaskDetailEditForm`, and is covered at the UI tier instead
 * (see the "hides the placement control once the task has a worktree_path" test
 * in tests/ui/new-task-dialog.spec.ts). `PriorityLabelsRow` reads Zustand
 * store hooks (`useConfigStore`, `useAllExistingLabels`), so it cannot be
 * called this way without a reconciler.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { Info } from 'lucide-react';
import { Field } from '../../src/renderer/components/Field';
import { DialogFooterActions } from '../../src/renderer/components/dialogs/DialogFooterActions';
import { WorktreePlacementControl } from '../../src/renderer/components/dialogs/WorktreePlacementControl';
import { SegmentedControl, type SegmentedControlOption } from '../../src/renderer/components/SegmentedControl';

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

/** Depth-first search for the first element whose className includes `substring`. */
function findByClassNameIncluding(node: unknown, substring: string): ElementLike | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClassNameIncluding(child, substring);
      if (found) return found;
    }
    return null;
  }
  if (isElementLike(node)) {
    const className = node.props.className;
    if (typeof className === 'string' && className.includes(substring)) return node;
    return findByClassNameIncluding(node.props.children, substring);
  }
  return null;
}

/** Depth-first search for the first element whose `type` is `target` (reference equality). */
function findByType(node: unknown, target: unknown): ElementLike | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, target);
      if (found) return found;
    }
    return null;
  }
  if (isElementLike(node)) {
    if (node.type === target) return node;
    return findByType(node.props.children, target);
  }
  return null;
}

/** Depth-first collection of every native `<button>` element in the tree. */
function findAllButtons(node: unknown, results: ElementLike[] = []): ElementLike[] {
  if (node === null || node === undefined || typeof node === 'boolean') return results;
  if (Array.isArray(node)) {
    node.forEach((child) => findAllButtons(child, results));
    return results;
  }
  if (isElementLike(node)) {
    if (node.type === 'button') results.push(node);
    findAllButtons(node.props.children, results);
  }
  return results;
}

describe('Field', () => {
  it('renders the error message and suppresses the hint (and its info icon) when both are set', () => {
    const output = Field({
      label: 'Branch',
      children: React.createElement('input'),
      hint: 'Auto-generated branch will be created from main',
      error: 'Invalid git branch name',
    });

    const errorParagraph = findByClassNameIncluding(output, 'text-danger');
    expect(errorParagraph).not.toBeNull();
    expect(collectText(errorParagraph)).toBe('Invalid git branch name');

    // The hint paragraph must not render at all while an error is present -
    // not merely be visually overridden. Both the hint text and its Info icon
    // must be absent from the output tree.
    const hintParagraph = findByClassNameIncluding(output, 'text-fg-disabled');
    expect(hintParagraph).toBeNull();
    expect(collectText(output)).not.toContain('Auto-generated branch will be created from main');
    expect(findByType(output, Info)).toBeNull();
  });

  it('renders the hint (with its info icon) when there is no error', () => {
    const output = Field({
      label: 'Branch',
      children: React.createElement('input'),
      hint: 'Auto-generated branch will be created from main',
    });

    const hintParagraph = findByClassNameIncluding(output, 'text-fg-disabled');
    expect(hintParagraph).not.toBeNull();
    expect(collectText(hintParagraph)).toBe('Auto-generated branch will be created from main');
    expect(findByType(output, Info)).not.toBeNull();
    expect(findByClassNameIncluding(output, 'text-danger')).toBeNull();
  });
});

describe('DialogFooterActions', () => {
  it('renders the submit button as type="submit" when onSubmit is omitted (NewTaskDialog\'s form-submit shape)', () => {
    const output = DialogFooterActions({
      onCancel: () => {},
      submitLabel: 'Create',
    });

    const buttons = findAllButtons(output);
    const cancelButton = buttons.find((button) => collectText(button).includes('Cancel'));
    const submitButton = buttons.find((button) => collectText(button).includes('Create'));

    expect(cancelButton).toBeDefined();
    expect(cancelButton?.props.type).toBe('button');

    // This is the exact shape NewTaskDialog relies on: it never passes
    // `onSubmit`, so its <form onSubmit={handleSubmit}> only fires when THIS
    // button's native type="submit" triggers it.
    expect(submitButton).toBeDefined();
    expect(submitButton?.props.type).toBe('submit');
    expect(submitButton?.props.onClick).toBeUndefined();
  });

  it('renders the submit button as type="button" when onSubmit is passed (TaskDetailWindow\'s formless footer)', () => {
    const handleSave = () => {};
    const output = DialogFooterActions({
      onCancel: () => {},
      onSubmit: handleSave,
      submitLabel: 'Save',
    });

    const buttons = findAllButtons(output);
    const cancelButton = buttons.find((button) => collectText(button).includes('Cancel'));
    const submitButton = buttons.find((button) => collectText(button).includes('Save'));

    expect(cancelButton).toBeDefined();
    expect(cancelButton?.props.type).toBe('button');

    // TaskDetailWindow has no surrounding <form>, so if this regressed to
    // type="submit" the click would do nothing (no form to submit) rather
    // than silently calling handleSave via a native submission.
    expect(submitButton).toBeDefined();
    expect(submitButton?.props.type).toBe('button');
    expect(submitButton?.props.onClick).toBe(handleSave);
  });
});

describe('WorktreePlacementControl', () => {
  // The control is the shared `SegmentedControl` (whose own `type="button"`
  // guard covers the <form> hazard), so what is worth pinning here is the
  // mapping this wrapper adds on top: the option set, and the blocked state.
  function segmentedProps(output: unknown) {
    const segmented = findByType(output, SegmentedControl);
    expect(segmented).not.toBeNull();
    return segmented!.props as {
      value: string;
      options: readonly SegmentedControlOption<string>[];
      onChange: (value: string) => void;
    };
  }

  it('offers Worktree and Project through the shared SegmentedControl', () => {
    const output = WorktreePlacementControl({ value: 'worktree', onChange: () => {} });

    const props = segmentedProps(output);
    expect(props.value).toBe('worktree');
    expect(props.options.map((option) => option.value)).toEqual(['worktree', 'project']);
    expect(props.options.map((option) => option.testId)).toEqual(['worktree-option-worktree', 'worktree-option-project']);
    expect(props.options.every((option) => option.disabled !== true)).toBe(true);
  });

  it('ignores a re-click of the selected option so a task following the global setting is not pinned', () => {
    const writes: string[] = [];
    const output = WorktreePlacementControl({ value: 'worktree', onChange: (next) => writes.push(next) });

    const props = segmentedProps(output);
    props.onChange('worktree');
    expect(writes).toEqual([]);
    props.onChange('project');
    expect(writes).toEqual(['project']);
  });

  it('reads Project selected and Worktree disabled when the project cannot have a worktree', () => {
    // The parent may still hold `useWorktree: true` (the global default); the
    // control must not show a worktree the manager will skip.
    const output = WorktreePlacementControl({
      value: 'worktree',
      onChange: () => {},
      blockedReason: 'Not a git repository',
    });

    const props = segmentedProps(output);
    expect(props.value).toBe('project');
    const [worktreeOption, projectOption] = props.options;
    expect(worktreeOption.disabled).toBe(true);
    expect(worktreeOption.title).toBe('Not a git repository');
    expect(projectOption.disabled).not.toBe(true);

    // The reason also sits on a wrapper: a disabled button does not fire the
    // mouse events a tooltip needs.
    expect(isElementLike(output) && output.props.title).toBe('Not a git repository');
  });
});
