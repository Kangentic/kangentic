import type { ReactNode } from 'react';
import { Field } from '../Field';
import { BranchPicker } from './BranchPicker';
import { WorktreeChip } from './WorktreeChip';

interface TaskBranchRowProps {
  /**
   * Custom branch name. Omit to render the base-branch + worktree pair alone,
   * for a task past To Do whose branch name is no longer editable.
   */
  customBranchName?: string;
  setCustomBranchName?: (value: string) => void;
  /** Resolved auto-generated name, shown as the input's placeholder. */
  branchPlaceholder?: string;
  branchNameError?: string;
  /**
   * Explains what the branch settings will do. Omitted past To Do, where the
   * hint's "will be created from ..." phrasing describes a decision the task has
   * already made.
   */
  branchHint?: ReactNode;
  baseBranch: string;
  setBaseBranch: (value: string) => void;
  /** May be empty; the `|| 'main'` fallback is applied here, once, for every caller. */
  defaultBaseBranch: string;
  effectiveWorktree: boolean;
  setUseWorktree: (value: boolean) => void;
  /** Hide the worktree segment (a task that already has a worktree on disk). */
  showWorktree?: boolean;
}

/**
 * The Branch field, as ONE composed control rather than five loose ones.
 *
 * It used to be `[input] from [pill] | [pill]`: a text input, a bare "from", a
 * rounded-full branch pill, a hand-drawn divider, and a rounded-full worktree
 * pill, at three radii and two heights. Now it is a single bordered shell with
 * flush segments and internal dividers, which is the shape `Combobox` already
 * uses in this same dialog for its chevron button.
 *
 * The bare "from" is gone rather than restyled. The hint line underneath already
 * says "will be created from `main`", so the word was stating the relationship a
 * second time in the cramped part of the row.
 *
 * Shared by NewTaskDialog and TaskDetailEditForm so the two cannot drift; the
 * second, name-less cluster in TaskDetailEditForm is this component with
 * `customBranchName` omitted.
 */
export function TaskBranchRow({
  customBranchName,
  setCustomBranchName,
  branchPlaceholder,
  branchNameError,
  branchHint,
  baseBranch,
  setBaseBranch,
  defaultBaseBranch,
  effectiveWorktree,
  setUseWorktree,
  showWorktree = true,
}: TaskBranchRowProps) {
  const editableName = setCustomBranchName !== undefined;

  return (
    // Past To Do there is no branch name to edit, so the field is only choosing a
    // base branch - which is what it says. Naming it "Branch" there would promise
    // an editable branch name that is not on offer.
    <Field
      label={editableName ? 'Branch' : 'Base branch'}
      error={branchNameError}
      hint={branchHint}
    >
      {/* min-h-[34px] rather than letting the input's own padding set the height:
          the segments carry no vertical padding (items-stretch fills them to the
          shell), so with the name input absent - the past-To-Do case - the shell
          collapsed to an 18px sliver. The floor makes the height independent of
          which children are present, and matches FIELD_CONTROL_CLASS's 34px.

          The internal dividers come from `divide-x` on the shell rather than a
          `border-l` on each segment, so the leading edge is never doubled up
          against the shell's own border - which matters because WHICH segment
          comes first changes with `editableName`.

          Without a name input there is nothing to stretch, so the shell
          shrink-wraps (inline-flex) instead of running the full width with dead
          space where the input used to be.

          The shell border does NOT light on focus. Each of the three segments is
          separately focusable and separately actionable, so a border that lights
          for all of them says "something in here has focus" without saying what -
          and it was redundant besides, since the two buttons already draw their
          own inset ring. Focus is indicated locally, on the segment that has it. */}
      <div
        className={`${editableName ? 'flex' : 'inline-flex'} min-h-[34px] items-stretch divide-x divide-edge-input overflow-hidden rounded border bg-surface-control transition-colors ${
          branchNameError ? 'border-danger' : 'border-edge-input'
        }`}
        data-testid="task-branch-row"
      >
        {editableName && (
          <input
            data-testid="custom-branch-name-input"
            type="text"
            placeholder={branchPlaceholder}
            value={customBranchName ?? ''}
            onChange={(event) => setCustomBranchName?.(event.target.value)}
            // `focus`, not `focus-visible`, unlike the two buttons: clicking into
            // a text field should show that it took focus, which is how every
            // other input in this dialog behaves. A button clicked with the mouse
            // should not keep a ring, which is what focus-visible gets right.
            className="min-w-0 flex-1 bg-transparent px-3 py-1.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent"
          />
        )}
        <BranchPicker
          variant="segment"
          value={baseBranch}
          defaultBranch={defaultBaseBranch || 'main'}
          onChange={setBaseBranch}
        />
        {showWorktree && (
          <WorktreeChip
            enabled={effectiveWorktree}
            onToggle={() => setUseWorktree(effectiveWorktree ? false : true)}
          />
        )}
      </div>
    </Field>
  );
}
