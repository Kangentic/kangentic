/**
 * Unit tests for HMR instance pinning in src/renderer/stores/board-store.ts
 * (Pattern E, see .claude/rules/hmr-patterns.md).
 *
 * board-store's only runtime export is the non-component `useBoardStore`, so the
 * module is not a React Fast Refresh boundary. Without pinning, a Fast Refresh
 * that re-evaluates this module (a slice edit, or an edit to a store it imports)
 * constructs a SECOND store instance while the mounted KanbanBoard stays
 * subscribed to the first - the agent/MCP-created-task split-brain (the card
 * lands in the store via getState() but the board never re-renders until a full
 * reload). The fix pins the instance in `import.meta.hot.data`:
 *
 *   export const useBoardStore = import.meta.hot?.data?.boardStore ?? createBoardStore();
 *   import.meta.hot.data.boardStore = useBoardStore;
 *   import.meta.hot.accept(() => import.meta.hot.invalidate());
 *
 * In vitest node mode `import.meta.hot` is undefined, so:
 *   - the cold path always runs: `useBoardStore` is a fresh `createBoardStore()`;
 *   - the `if (import.meta.hot)` pin block is skipped (production-like behavior).
 * We therefore verify (1) cold-init defaults, (2) `createBoardStore()` is a real
 * factory that yields independent instances (the property that makes pinning
 * meaningful), and (3) the preservation contract by simulating the HMR
 * round-trip against the same expression the module uses.
 *
 * The fine-grained pin/self-accept lines are guarded mechanically by the
 * "Pattern E" check in tests/unit/hmr-resync.test.ts. This file locks the
 * factory's behavior and the resolve contract.
 */

import { describe, it, expect } from 'vitest';
import { useBoardStore, createBoardStore } from '../../src/renderer/stores/board-store';

describe('board-store HMR instance pinning (Pattern E)', () => {
  it('cold-init: the module exports a working store with empty board defaults', () => {
    const state = useBoardStore.getState();
    expect(Array.isArray(state.tasks)).toBe(true);
    expect(state.tasks).toHaveLength(0);
    expect(Array.isArray(state.swimlanes)).toBe(true);
    expect(state.swimlanes).toHaveLength(0);
    expect(state.hydrated).toBe(false);
    expect(typeof state.loadBoard).toBe('function');
  });

  it('createBoardStore() yields independent instances (a real factory)', () => {
    const storeA = createBoardStore();
    const storeB = createBoardStore();
    expect(storeA).not.toBe(storeB);

    // Mutating one must not affect the other - proves they do not share state.
    storeA.setState({ hydrated: true });
    expect(storeA.getState().hydrated).toBe(true);
    expect(storeB.getState().hydrated).toBe(false);

    // And neither is the module singleton.
    expect(storeA).not.toBe(useBoardStore);
  });

  it('preservation contract: the pin round-trips the SAME instance across HMR', () => {
    // Simulate the module's pin: stash the live instance into hot.data...
    const hotData: Record<string, unknown> = {};
    hotData.boardStore = useBoardStore;

    // ...then the next module evaluation resolves it back via the same
    // expression the module uses: `import.meta.hot?.data?.boardStore ?? createBoardStore()`.
    const preserved = hotData.boardStore as typeof useBoardStore | undefined;
    const resolved = preserved ?? createBoardStore();

    // The pinned instance is reused, never replaced - the guarantee that kills
    // the split-brain. A bare `createBoardStore()` would return a new object.
    expect(resolved).toBe(useBoardStore);
  });

  it('cold path (no preserved instance) constructs a fresh store', () => {
    const hotData: Record<string, unknown> = {};
    const preserved = hotData.boardStore as typeof useBoardStore | undefined;
    const resolved = preserved ?? createBoardStore();
    expect(resolved).not.toBe(useBoardStore);
    expect(typeof resolved.getState().loadBoard).toBe('function');
  });
});
