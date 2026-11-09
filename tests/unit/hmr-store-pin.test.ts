import { describe, it, expect, vi } from 'vitest';
import { create, type StateCreator, type StoreApi } from 'zustand';
import { refreshPinnedStore, sharedModuleState } from '../../src/renderer/stores/hmr-store-pin';

/**
 * The Pattern E refresh: a pinned store's module re-evaluates with new code and
 * hands the preserved instance the new initializer. What a dogfood window loses
 * without it is every action a merge adds to a pinned store (#1052's
 * `requestBrowserNavigate`), until a full reload that destroys every Browser
 * pane guest. See .claude/rules/hmr-patterns.md.
 */

interface CounterStateV1 {
  count: number;
  label: string;
  increment: () => void;
  setLabel: (label: string) => void;
}

interface CounterStateV2 extends CounterStateV1 {
  history: number[];
  addMany: (amount: number) => void;
}

const initializerV1: StateCreator<CounterStateV1, [], []> = (set) => ({
  count: 0,
  label: 'initial',
  increment: () => set((state) => ({ count: state.count + 1 })),
  setLabel: (label) => set({ label }),
});

// The same store after an edit: `increment` steps by 10 now, `setLabel` is
// untouched, and `history` plus `addMany` are new.
const initializerV2: StateCreator<CounterStateV2, [], []> = (set) => ({
  count: 0,
  label: 'initial',
  history: [],
  increment: () => set((state) => ({ count: state.count + 10 })),
  setLabel: (label) => set({ label }),
  addMany: (amount) => set((state) => ({ count: state.count + amount, history: [...state.history, amount] })),
});

describe('sharedModuleState', () => {
  interface PendingState {
    pendingCount: number;
    labels: string[];
  }

  it('hands every evaluation the same object and stashes it in the hot data', () => {
    const hotData: Record<string, unknown> = {};
    const firstEvaluation = sharedModuleState<PendingState>(hotData, 'pending', () => ({ pendingCount: 0, labels: [] }));
    firstEvaluation.pendingCount = 3;
    const secondEvaluation = sharedModuleState<PendingState>(hotData, 'pending', () => ({ pendingCount: 0, labels: [] }));

    expect(hotData.pending, 'the first call stashed its object').toBe(firstEvaluation);
    expect(secondEvaluation, 'the second evaluation shares the same object').toBe(firstEvaluation);
    expect(secondEvaluation.pendingCount, 'live data is not reset').toBe(3);
  });

  it('is a plain fresh object with no hot data, and stashes nothing', () => {
    const first = sharedModuleState<PendingState>(undefined, 'pending', () => ({ pendingCount: 0, labels: [] }));
    const second = sharedModuleState<PendingState>(undefined, 'pending', () => ({ pendingCount: 0, labels: [] }));

    expect(first).toEqual({ pendingCount: 0, labels: [] });
    expect(second, 'each call outside Vite builds its own object').not.toBe(first);
  });

  it('replaces a stashed value that is not an object with the initial state', () => {
    for (const unusable of [null, 'text', 7, undefined]) {
      const hotData: Record<string, unknown> = { pending: unusable };
      const state = sharedModuleState<PendingState>(hotData, 'pending', () => ({ pendingCount: 0, labels: [] }));
      expect(state).toEqual({ pendingCount: 0, labels: [] });
      expect(hotData.pending, 'the replacement is stashed').toBe(state);
    }
  });

  it('fills a field an earlier evaluation lacks on the same object, and keeps a live field', () => {
    const earlierEvaluation = { pendingCount: 5 };
    const hotData: Record<string, unknown> = { pending: earlierEvaluation };

    const state = sharedModuleState<PendingState>(hotData, 'pending', () => ({ pendingCount: 0, labels: ['initial'] }));

    expect(state, 'the object old actions hold is kept').toBe(earlierEvaluation);
    expect(state.labels, 'the new field takes its initial value').toEqual(['initial']);
    expect(state.pendingCount, 'a field the object already has keeps its live value').toBe(5);
  });
});

describe('refreshPinnedStore', () => {
  it('gives the preserved instance the new and changed actions and keeps its data', () => {
    const preservedStore = create<CounterStateV1>(initializerV1);
    preservedStore.getState().increment();
    preservedStore.getState().setLabel('live');
    const setLabelBefore = preservedStore.getState().setLabel;
    const listener = vi.fn();
    preservedStore.subscribe(listener);

    // The preserved instance was typed by the old module; the new module types it by the new one.
    refreshPinnedStore(preservedStore as unknown as StoreApi<CounterStateV2>, initializerV2);

    const refreshedState = preservedStore.getState() as unknown as CounterStateV2;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(refreshedState.count, 'live data survives').toBe(1);
    expect(refreshedState.label, 'live data survives').toBe('live');
    expect(refreshedState.history, 'a new key arrives with its initial value').toEqual([]);
    expect(refreshedState.setLabel, 'an unchanged action keeps its identity').toBe(setLabelBefore);

    refreshedState.addMany(5);
    expect(preservedStore.getState().count, 'the new action works on the live store').toBe(6);
    refreshedState.increment();
    expect(preservedStore.getState().count, 'the changed action is the new one').toBe(16);
  });

  it('writes nothing when the new code changes no action and adds no key', () => {
    const preservedStore = create<CounterStateV1>(initializerV1);
    preservedStore.getState().increment();
    const listener = vi.fn();
    preservedStore.subscribe(listener);

    refreshPinnedStore(preservedStore, initializerV1);

    expect(listener).not.toHaveBeenCalled();
    expect(preservedStore.getState().count).toBe(1);
  });

  it('never replaces live data, even when the new initial value differs', () => {
    const preservedStore = create<CounterStateV1>(initializerV1);
    const initializerWithNewDefault: StateCreator<CounterStateV1, [], []> = (set, get, api) => ({
      ...initializerV1(set, get, api),
      count: 99,
      label: 'new default',
    });

    refreshPinnedStore(preservedStore, initializerWithNewDefault);

    expect(preservedStore.getState().count).toBe(0);
    expect(preservedStore.getState().label).toBe('initial');
  });
});
