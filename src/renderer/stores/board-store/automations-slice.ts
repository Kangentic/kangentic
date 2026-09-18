import { type StateCreator } from 'zustand';
import type { AutomationRunAgainResult, AutomationWriteInput, ColumnAutomation } from '../../../shared/types';
import { runnableAutomationCounts, toDraft } from '../../components/dialogs/board-manager/automation-drafts';
import { useProjectStore } from '../project-store';
import type { BoardStore } from './types';

/**
 * Every column's automations, for the whole board.
 *
 * Board-wide rather than per-column because three consumers need the same
 * numbers at once and must agree: the rail's per-column count, the board
 * column header's glyph, and the All columns table. A per-column fetch would
 * let them drift.
 */
export interface AutomationsSlice {
  automations: ColumnAutomation[];
  automationsLoaded: boolean;
  loadAutomations: () => Promise<void>;
  replaceAutomationsForColumn: (columnId: string, automations: AutomationWriteInput[]) => Promise<void>;
  /**
   * Re-run ONE automation against the task's CURRENT state. The result is the
   * whole answer: nothing in the renderer holds run history any more (the
   * Column Manager row used to print its last run, and no longer does), so
   * there is nothing to re-read afterwards.
   */
  runAutomationAgain: (automationId: string, taskId: string) => Promise<AutomationRunAgainResult>;
}

export const createAutomationsSlice: StateCreator<BoardStore, [], [], AutomationsSlice> = (set, get) => ({
  automations: [],
  automationsLoaded: false,

  loadAutomations: async () => {
    try {
      const automations = await window.electronAPI.automations.list();
      set({ automations, automationsLoaded: true });
    } catch (error) {
      // Keep the last known list rather than blanking the board's counts on a
      // transient failure, the same call the board profiles loader makes.
      console.warn('[automations] load failed; keeping the last known list', error);
    }
  },

  replaceAutomationsForColumn: async (columnId, automations) => {
    // The project id is stamped at interaction time, per project-scoped-ipc.md:
    // Save can take a moment, and a project switch in that window would
    // otherwise write this column's rows into the wrong project's database.
    const projectId = useProjectStore.getState().currentProject?.id ?? null;
    // Awaited, then re-read from main rather than merged locally: the write
    // assigns each row its position per trigger and mints ids for the new ones,
    // so main's answer is the only correct picture of what was saved.
    await window.electronAPI.automations.replaceForColumn(columnId, automations, projectId);
    await get().loadAutomations();
  },

  runAutomationAgain: async (automationId, taskId) => {
    const projectId = useProjectStore.getState().currentProject?.id ?? null;
    return window.electronAPI.automations.runAgain(automationId, taskId, projectId);
  },
});

/**
 * What will RUN on a column, by group.
 *
 * The ONE derivation behind the rail count, the board glyph and the overview,
 * so a column cannot read "5" in one place and "3" in another. A switched-off or
 * blocked row is deliberately not counted: this answers "what happens when a
 * task moves", and an off row is visible and fixable one click away.
 *
 * NOT a zustand selector, despite the name it shares with one. It returns a
 * fresh object, and zustand compares snapshots with `Object.is`, so passing it
 * to `useBoardStore` directly makes every store read look like a change and
 * loops the component until React gives up. Select the two arrays and derive
 * this in a `useMemo`, as `AutomationGlyph` does.
 */
export function selectAutomationCounts(
  state: Pick<BoardStore, 'automations' | 'swimlanes'>,
  swimlaneId: string,
): { enter: number; exit: number } {
  const column = state.swimlanes.find((lane) => lane.id === swimlaneId);
  if (!column) return { enter: 0, exit: 0 };
  const drafts = state.automations.filter((row) => row.swimlane_id === swimlaneId).map(toDraft);
  return runnableAutomationCounts(drafts, column);
}
