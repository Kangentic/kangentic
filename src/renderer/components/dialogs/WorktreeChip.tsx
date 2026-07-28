import { FolderGit2 } from 'lucide-react';

interface WorktreeChipProps {
  enabled: boolean;
  onToggle: () => void;
}

/**
 * The worktree on/off control, rendered as the trailing segment of the composed
 * Branch field (see `TaskBranchRow`).
 *
 * Three deliberate departures from the pill it used to be:
 *
 *   - It is flush, not rounded: the Branch field is ONE control whose dividers
 *     are drawn by the shell's `divide-x`, the same shape `Combobox` uses for its
 *     chevron button. A `rounded-full` pill inside a `rounded` shell was the
 *     single loudest source of the row's mixed vocabulary.
 *   - The off state is muted, not struck through. `line-through` on a toggle
 *     reads as "deleted" rather than "off", and it was the only strikethrough in
 *     the app. The state now lives on `aria-pressed` / `data-enabled`, which is
 *     also what tests should assert on rather than a styling class.
 *   - On/off is carried by BRIGHTNESS - a fuller fill and full-weight text when
 *     on, a recessed fill and dimmed text when off. Two louder versions were
 *     tried and dropped: an explicit checkbox glyph (a tick plus a folder icon
 *     plus the word "Worktree" is three marks for one boolean, and the tick
 *     introduced a second "selected" idiom competing with the run-mode radio
 *     dots just below), then an accent wash borrowed from the Write/Preview
 *     toggle (hue is too strong a signal for a small boolean sitting inside
 *     another field - it became the only coloured thing in the row). Neutral
 *     contrast is the same way the run-mode cards mark their live branch.
 *
 * `type="button"` is NOT optional: `NewTaskDialog` wraps its whole body in a
 * `<form>`, so a bare button here submits the form and creates the task.
 */
export function WorktreeChip({ enabled, onToggle }: WorktreeChipProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      data-enabled={enabled}
      // Inset focus ring for the same reason as the branch segment: the shell is
      // `overflow-hidden`, so a default outline on a flush segment is clipped.
      // `cursor-pointer` is explicit because Tailwind v4's preflight gives
      // `button` `cursor: default`, and the `Pill` this replaced supplied it.
      className={`flex shrink-0 cursor-pointer items-center gap-1.5 px-3 text-xs transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
        enabled
          ? 'bg-surface-hover/70 text-fg-secondary'
          : 'bg-surface-hover/25 text-fg-disabled hover:bg-surface-hover/50 hover:text-fg-muted'
      }`}
      title={enabled ? 'Worktree enabled (click to turn off)' : 'Worktree disabled (click to turn on)'}
      data-testid="worktree-toggle"
    >
      <FolderGit2 size={14} />
      <span>Worktree</span>
    </button>
  );
}
