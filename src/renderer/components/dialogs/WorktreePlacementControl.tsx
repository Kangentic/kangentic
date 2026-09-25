import { FolderGit, FolderGit2 } from 'lucide-react';
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl';

/** Where a task's agent runs: its own worktree, or the project folder. */
export type WorktreePlacement = 'worktree' | 'project';

interface WorktreePlacementControlProps {
  value: WorktreePlacement;
  onChange: (value: WorktreePlacement) => void;
  /**
   * Why the project cannot have a worktree at all (not a git repo, itself a
   * worktree, no commits, remote agent). Disables the Worktree option with the
   * reason as its tooltip and shows Project selected, so the control never
   * offers a worktree the manager will silently skip.
   */
  blockedReason?: string | null;
}

const WORKTREE_TITLE = 'Run in a new worktree';
const PROJECT_TITLE = 'Run in the project folder';

/**
 * Module scope, like the Board Manager's timing options: `SegmentedControl`
 * keys a layout effect on the `options` identity, so a fresh array per render
 * would re-measure the thumb on every keystroke in the dialog.
 */
const OPEN_OPTIONS: readonly SegmentedControlOption<WorktreePlacement>[] = [
  { value: 'worktree', label: 'Worktree', icon: <FolderGit2 size={14} />, title: WORKTREE_TITLE, testId: 'worktree-option-worktree' },
  { value: 'project', label: 'Project', icon: <FolderGit size={14} />, title: PROJECT_TITLE, testId: 'worktree-option-project' },
];

/**
 * The blocked option set for a given reason, cached so its identity is stable
 * across renders for the same reason. The module comment above applies to the
 * blocked branch too: being blocked is a fixed STATE for the dialog's life, but
 * a `[...]` literal in the render body is a fresh ARRAY on every render, which
 * re-runs `SegmentedControl`'s options-keyed layout effect (two forced layouts
 * plus a rebuilt `ResizeObserver`) on every keystroke in the dialog.
 *
 * A cache rather than `useMemo` because this component is deliberately hookless
 * (see below). It is bounded by `describeWorktreeBlocker`'s four fixed strings,
 * which is the only thing any caller passes.
 */
const blockedOptionsByReason = new Map<string, readonly SegmentedControlOption<WorktreePlacement>[]>();

function blockedOptionsFor(reason: string): readonly SegmentedControlOption<WorktreePlacement>[] {
  const cached = blockedOptionsByReason.get(reason);
  if (cached) return cached;
  const built: readonly SegmentedControlOption<WorktreePlacement>[] = [
    { ...OPEN_OPTIONS[0], title: reason, disabled: true },
    OPEN_OPTIONS[1],
  ];
  blockedOptionsByReason.set(reason, built);
  return built;
}

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
    : OPEN_OPTIONS;

  const control = (
    <SegmentedControl
      ariaLabel="Where the agent runs"
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

  // `title` on a WRAPPER as well as the option: a disabled button does not fire
  // the mouse events a tooltip needs, so the reason would otherwise be unreachable
  // by hover (the Board Manager's timing control does the same).
  return blocked
    ? <span title={blockedReason} data-testid="worktree-placement-blocked">{control}</span>
    : control;
}
