import { FolderGit, FolderGit2 } from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl';
import { cachePerCatalog, cachePerCatalogBy } from '../../i18n/catalog-cache';

/** Where a task's agent runs: its own worktree, or the project folder. */
export type WorktreePlacement = 'worktree' | 'project';

interface WorktreePlacementControlProps {
  value: WorktreePlacement;
  onChange: (value: WorktreePlacement) => void;
  /**
   * Why the project cannot have a worktree at all (not a git repo, itself a
   * worktree, no commits, remote agent). Disables the Worktree option with the
   * reason as its tip and shows Project selected, so the control never
   * offers a worktree the manager will silently skip.
   */
  blockedReason?: string | null;
}

const WORKTREE_PLACEMENT_MESSAGES = {
  worktreeLabel: msg({ message: 'Worktree', context: 'placement option' }),
  projectLabel: msg({ message: 'Project', context: 'placement option' }),
  worktreeTip: msg`Run in a new worktree`,
  projectTip: msg`Run in the project folder`,
};

/**
 * Built once until the catalog changes, so the array keeps its identity across
 * renders: `SegmentedControl` keys a layout effect on the `options` identity, so
 * a fresh array per render would re-measure the thumb on every keystroke in the
 * dialog. The labels are descriptors resolved here, at render time, after the
 * catalog loads, never at module scope.
 */
const openOptions = cachePerCatalog((): readonly SegmentedControlOption<WorktreePlacement>[] => [
  { value: 'worktree', label: i18n._(WORKTREE_PLACEMENT_MESSAGES.worktreeLabel), icon: <FolderGit2 size={14} />, tip: i18n._(WORKTREE_PLACEMENT_MESSAGES.worktreeTip), testId: 'worktree-option-worktree' },
  { value: 'project', label: i18n._(WORKTREE_PLACEMENT_MESSAGES.projectLabel), icon: <FolderGit size={14} />, tip: i18n._(WORKTREE_PLACEMENT_MESSAGES.projectTip), testId: 'worktree-option-project' },
]);

/**
 * The blocked option set for a given reason, cached so its identity is stable
 * across renders for the same reason. The comment above applies to the blocked
 * branch too: being blocked is a fixed STATE for the dialog's life, but a
 * `[...]` literal in the render body is a fresh ARRAY on every render, which
 * re-runs `SegmentedControl`'s options-keyed layout effect (two forced layouts
 * plus a rebuilt `ResizeObserver`) on every keystroke in the dialog.
 *
 * A cache rather than `useMemo` because this component is deliberately hookless
 * (see below). It is bounded by `describeWorktreeBlocker`'s four fixed strings,
 * which is the only thing any caller passes.
 */
const blockedOptionsFor = cachePerCatalogBy((reason: string): readonly SegmentedControlOption<WorktreePlacement>[] => {
  const [worktreeOption, projectOption] = openOptions();
  return [{ ...worktreeOption, disabledReason: reason, disabled: true }, projectOption];
});

/**
 * Where the task's agent runs, beside the Branch field: the shared
 * `SegmentedControl` with two options, Worktree or Project.
 *
 * It replaced a single "Worktree" on/off button that sat INSIDE the Branch
 * shell as a flush segment. That button's off state had a name (the project
 * folder), and a boolean whose off state has a name reads better as a choice
 * between two named things than as a dimmed toggle, which is the same call
 * `SegmentedControl` documents against `ToggleCard`. Standing beside the shell
 * with a gap, rather than inside it, is what makes it read as its own decision:
 * inside, a two-way choice looked like part of the branch name. The two glyphs
 * are the pair the task detail's folder button uses, so what is picked here is
 * what the detail shows afterwards.
 *
 * Hookless on purpose, so the unit tier can call it as a plain function and
 * assert the blocked mapping; the hooks live in `SegmentedControl`.
 */
export function WorktreePlacementControl({ value, onChange, blockedReason = null }: WorktreePlacementControlProps) {
  const blocked = blockedReason !== null;
  const selected: WorktreePlacement = blocked ? 'project' : value;

  const options: readonly SegmentedControlOption<WorktreePlacement>[] = blocked
    ? blockedOptionsFor(blockedReason)
    : openOptions();

  return (
    <SegmentedControl
      ariaLabel={i18n._(msg`Where the agent runs`)}
      testId="worktree-placement"
      quiet
      value={selected}
      // Re-clicking the selected option is a no-op rather than a write, so a
      // task following the global setting is not pinned to an explicit override
      // by a click that changed nothing.
      onChange={(next) => { if (next !== selected) onChange(next); }}
      options={options}
    />
  );
}
