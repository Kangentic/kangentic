import { type StateCreator } from 'zustand';
import type { BoardStore } from './types';

export type BoardView = 'board' | 'backlog' | 'workflows';

export interface ActiveViewSlice {
  activeView: BoardView;
  /** The view the Workflows shortcut returns to when pressed in Workflows. */
  viewBeforeWorkflows: Exclude<BoardView, 'workflows'>;
  setActiveView: (view: BoardView) => void;
}

export const createActiveViewSlice: StateCreator<BoardStore, [], [], ActiveViewSlice> = (set, get) => ({
  activeView: 'board',
  viewBeforeWorkflows: 'board',
  setActiveView: (view) => {
    const previous = get().activeView;
    set(view === 'workflows' && previous !== 'workflows'
      ? { activeView: view, viewBeforeWorkflows: previous }
      : { activeView: view });
    // Adoption signal for the backlog view, whatever opened it (the toggle,
    // its hotkey, the search palette); main dedups to once per day.
    if (view === 'backlog') window.electronAPI?.analytics?.trackFeatureUsed('backlog');
  },
});
