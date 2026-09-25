import { type StateCreator } from 'zustand';
import type { BoardStore } from './types';

export interface ActiveViewSlice {
  activeView: 'board' | 'backlog';
  setActiveView: (view: 'board' | 'backlog') => void;
}

export const createActiveViewSlice: StateCreator<BoardStore, [], [], ActiveViewSlice> = (set) => ({
  activeView: 'board',
  setActiveView: (view) => {
    set({ activeView: view });
    // Adoption signal for the backlog view, whatever opened it (the toggle,
    // its hotkey, the search palette); main dedups to once per day.
    if (view === 'backlog') window.electronAPI?.analytics?.trackFeatureUsed('backlog');
  },
});
