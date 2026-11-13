import { useMemo } from 'react';
import { plural } from '@lingui/core/macro';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { selectAutomationCounts } from '../../stores/board-store/automations-slice';
import { DEFAULT_AGENT } from '../../../shared/types';

/**
 * "3 automations run here: 2 on enter, 1 on exit". One whole message per set of
 * moments that has a count, so a translation never joins pieces of a sentence,
 * and each one a plural on the total, so "runs" agrees with it. Only a moment
 * with a count is named, as before.
 */
function automationsRunSentence(total: number, enterCount: number, turnEndCount: number, exitCount: number): string {
  if (enterCount > 0 && turnEndCount > 0 && exitCount > 0) {
    return plural(total, {
      one: `# automation runs here: ${enterCount} on enter, ${turnEndCount} at a turn end, ${exitCount} on exit`,
      other: `# automations run here: ${enterCount} on enter, ${turnEndCount} at a turn end, ${exitCount} on exit`,
    });
  }
  if (enterCount > 0 && turnEndCount > 0) {
    return plural(total, {
      one: `# automation runs here: ${enterCount} on enter, ${turnEndCount} at a turn end`,
      other: `# automations run here: ${enterCount} on enter, ${turnEndCount} at a turn end`,
    });
  }
  if (enterCount > 0 && exitCount > 0) {
    return plural(total, {
      one: `# automation runs here: ${enterCount} on enter, ${exitCount} on exit`,
      other: `# automations run here: ${enterCount} on enter, ${exitCount} on exit`,
    });
  }
  if (turnEndCount > 0 && exitCount > 0) {
    return plural(total, {
      one: `# automation runs here: ${turnEndCount} at a turn end, ${exitCount} on exit`,
      other: `# automations run here: ${turnEndCount} at a turn end, ${exitCount} on exit`,
    });
  }
  if (enterCount > 0) {
    return plural(total, {
      one: `# automation runs here: ${enterCount} on enter`,
      other: `# automations run here: ${enterCount} on enter`,
    });
  }
  if (turnEndCount > 0) {
    return plural(total, {
      one: `# automation runs here: ${turnEndCount} at a turn end`,
      other: `# automations run here: ${turnEndCount} at a turn end`,
    });
  }
  return plural(total, {
    one: `# automation runs here: ${exitCount} on exit`,
    other: `# automations run here: ${exitCount} on exit`,
  });
}

/**
 * The sentence a column header's tip gives for its automations: how many will
 * RUN when a task enters this column, when its agent finishes a turn here, or
 * when the task leaves. Null at zero: a column with nothing to run has nothing
 * to say.
 *
 * The header used to draw this as a glyph with the count. The Column Manager's
 * rail and its All columns table already show the same count, so the glyph's
 * place went to the Collapse button (#1056) and the sentence moved into the tip.
 *
 * The count is the SAME derivation the rail and the table use
 * (`selectAutomationCounts`), so a column can never read 5 here and 3 there. A
 * switched-off or blocked row is not counted: this answers "what happens when a
 * task moves", and an off row is visible and fixable one click away in Board
 * setup.
 */
export function useColumnAutomationSentence(swimlaneId: string): string | null {
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
    const agentInfo = agentList.find((agent) => agent.name === agentName);
    return selectAutomationCounts({ automations, swimlanes }, swimlaneId, agentInfo?.reportsTurnEnd, agentInfo?.reportsUserMessages);
  }, [automations, swimlanes, swimlaneId, agentList, projectDefaultAgent]);
  const total = counts.enter + counts.turn_end + counts.exit;
  if (total === 0) return null;

  // Both halves agree with the count: one automation RUNS, several RUN.
  return automationsRunSentence(total, counts.enter, counts.turn_end, counts.exit);
}

/**
 * A column header's tip: the column's description, with the automation sentence
 * under it. A column with no description leads with the sentence instead,
 * because Tooltip holds a tip with an empty label shut.
 */
export function columnHeaderTip(description: string | null | undefined, automationSentence: string | null): { label: string; detail?: string } {
  const text = description ?? '';
  if (text === '') return { label: automationSentence ?? '' };
  return automationSentence ? { label: text, detail: automationSentence } : { label: text };
}
