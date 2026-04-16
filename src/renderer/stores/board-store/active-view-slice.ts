import { type StateCreator } from 'zustand';
import type { BoardStore } from './types';

export interface ActiveViewSlice {
  activeView: 'board' | 'backlog';
  setActiveView: (view: 'board' | 'backlog') => void;
}

export const createActiveViewSlice: StateCreator<BoardStore, [], [], ActiveViewSlice> = (set) => ({
  activeView: 'board',
  setActiveView: (view) => set({ activeView: view }),
});
