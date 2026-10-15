import { useMemo } from 'react';
import { Columns3Cog } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { selectAutomationCounts } from '../../stores/board-store/automations-slice';
import { DEFAULT_AGENT } from '../../../shared/types';
import { HoverTip } from '../HoverTip';

/**
 * The column header's automation mark: `Columns3Cog`, a column with a cog, and
 * the number of automations
 * that will RUN when a task enters this column, when its agent finishes a turn
 * here, or when the task leaves.
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
  // The STABLE inputs are selected, and the counts are derived in a memo.
  // Passing `selectAutomationCounts` straight to the hook returns a fresh
  // object on every call, and zustand compares snapshots with `Object.is`, so
  // every store read looked like a change: React reported "getSnapshot should be
  // cached" and then blew the update depth. It renders once per column, so this
  // is the cheap side as well as the correct one.
  const automations = useBoardStore((state) => state.automations);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const agentList = useConfigStore((state) => state.agentList);
  const projectDefaultAgent = useProjectStore((state) => state.currentProject?.default_agent) ?? DEFAULT_AGENT;
  const counts = useMemo(() => {
    // A turn-end row counts only where the column's agent says when its turn
    // ends, the same answer the Column Manager gives.
    const lane = swimlanes.find((candidate) => candidate.id === swimlaneId);
    const agentName = lane?.agent_override ?? projectDefaultAgent;
    const reportsTurnEnd = agentList.find((agent) => agent.name === agentName)?.reportsTurnEnd;
    return selectAutomationCounts({ automations, swimlanes }, swimlaneId, reportsTurnEnd);
  }, [automations, swimlanes, swimlaneId, agentList, projectDefaultAgent]);
  const total = counts.enter + counts.turn_end + counts.exit;
  if (total === 0) return null;

  const parts: string[] = [];
  if (counts.enter > 0) parts.push(`${counts.enter} on enter`);
  if (counts.turn_end > 0) parts.push(`${counts.turn_end} at a turn end`);
  if (counts.exit > 0) parts.push(`${counts.exit} on exit`);
  // Both halves agree with the count: one automation RUNS, several RUN.
  const sentence = `${total} automation${total > 1 ? 's run' : ' runs'} here: ${parts.join(', ')}`;

  // The sentence is the glyph's name as well as its tip, so a screen reader hears it once.
  return (
    <HoverTip label={sentence}>
      <span
        role="img"
        aria-label={sentence}
        data-testid="column-automation-glyph"
        data-enter={counts.enter}
        data-turn-end={counts.turn_end}
        data-exit={counts.exit}
        className="flex flex-shrink-0 items-center gap-0.5 text-fg-disabled"
      >
        <Columns3Cog size={12} />
        <span className="text-[11px] tabular-nums">{total}</span>
      </span>
    </HoverTip>
  );
}
