import { type StateCreator } from 'zustand';
import type { BoardStore } from './types';

export interface BoardSearchSlice {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export const createBoardSearchSlice: StateCreator<BoardStore, [], [], BoardSearchSlice> = (set) => ({
  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),
});
