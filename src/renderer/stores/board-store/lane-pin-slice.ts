import { type StateCreator } from 'zustand';
import { EMPTY_LANE_PINS, type LanePin } from './lane-pins';
import type { BoardStore } from './types';

/**
 * Lane pins: the non-Done counterpart to `completingTaskIds`.
 *
 * Both guards are read at exactly one place - `KanbanBoard`'s `tasksPerLane`
 * memo, the single lane-bucketing chokepoint. `completingTaskIds` excludes a
 * task from every lane; `lanePins` redirects one to a different lane. Producers
 * live in the store (here and in `task-completion-slice`), consumers do not.
 * See `.claude/rules/board-completing-task-chokepoint.md`.
 */
export interface LanePinSlice {
  /** taskId -> pin. `EMPTY_LANE_PINS` when nothing is pinned (stable identity). */
  lanePins: ReadonlyMap<string, LanePin>;
  pinTaskLane: (taskId: string, pin: LanePin) => void;
  /**
   * Drop a pin, but only if it is still the one the caller set. The
   * `expectedLaneId` ownership check keeps a failing move from tearing down a
   * NEWER move's pin for the same task: `moveTask` pins during its optimistic
   * `set()` but does not claim its generation until after the pending-changes
   * probe, so two moves can briefly overlap without either seeing the other.
   */
  dropTaskLanePin: (taskId: string, expectedLaneId: string) => void;
  /** Drop every pin. Used on a project switch - pins never cross projects. */
  clearLanePins: () => void;
}

export const createLanePinSlice: StateCreator<BoardStore, [], [], LanePinSlice> = (set) => ({
  lanePins: EMPTY_LANE_PINS,

  pinTaskLane: (taskId, pin) => {
    set((state) => {
      const next = new Map(state.lanePins);
      next.set(taskId, pin);
      return { lanePins: next };
    });
  },

  dropTaskLanePin: (taskId, expectedLaneId) => {
    set((state) => {
      const existing = state.lanePins.get(taskId);
      if (!existing || existing.laneId !== expectedLaneId) return state;
      const next = new Map(state.lanePins);
      next.delete(taskId);
      return { lanePins: next.size === 0 ? EMPTY_LANE_PINS : next };
    });
  },

  clearLanePins: () => {
    set((state) => (state.lanePins.size === 0 ? state : { lanePins: EMPTY_LANE_PINS }));
  },
});
