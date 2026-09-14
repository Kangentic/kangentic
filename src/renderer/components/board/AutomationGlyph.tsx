import { useMemo } from 'react';
import { Zap } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { selectAutomationCounts } from '../../stores/board-store/automations-slice';

/**
 * The column header's automation mark: a `Zap` and the number of automations
 * that will RUN when a task enters or leaves this column.
 *
 * Hidden at zero, with no dimmed variant. A column with nothing to run has
 * nothing to say, and a permanently-dim glyph on most columns would be noise
 * the eye has to learn to skip.
 *
 * The count is the SAME derivation the rail and the All columns table use
 * (`selectAutomationCounts`), so a column can never read 5 here and 3 there. A
 * switched-off or blocked row is not counted: this answers "what happens when a
 * task moves", and an off row is visible and fixable one click away in Board
 * setup.
 */
export function AutomationGlyph({ swimlaneId }: { swimlaneId: string }) {
  // The two STABLE arrays are selected, and the counts are derived in a memo.
  // Passing `selectAutomationCounts` straight to the hook returns a fresh
  // `{ enter, exit }` object on every call, and zustand compares snapshots with
  // `Object.is`, so every store read looked like a change: React reported
  // "getSnapshot should be cached" and then blew the update depth. It renders
  // once per column, so this is the cheap side as well as the correct one.
  const automations = useBoardStore((state) => state.automations);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const counts = useMemo(
    () => selectAutomationCounts({ automations, swimlanes }, swimlaneId),
    [automations, swimlanes, swimlaneId],
  );
  const total = counts.enter + counts.exit;
  if (total === 0) return null;

  const parts: string[] = [];
  if (counts.enter > 0) parts.push(`${counts.enter} on enter`);
  if (counts.exit > 0) parts.push(`${counts.exit} on exit`);

  return (
    <span
      data-testid="column-automation-glyph"
      data-enter={counts.enter}
      data-exit={counts.exit}
      title={`${total} automation${total > 1 ? 's' : ''} run here: ${parts.join(', ')}`}
      className="flex flex-shrink-0 items-center gap-0.5 text-fg-disabled"
    >
      <Zap size={12} />
      <span className="text-[11px] tabular-nums">{total}</span>
    </span>
  );
}
