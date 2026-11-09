import type { StateCreator, StoreApi } from 'zustand';

/**
 * Pattern E refresh (see .claude/rules/hmr-patterns.md). A pinned store keeps
 * its instance across a hot update, so without this the actions it was built
 * with at boot are the actions it has for the life of the window: an action a
 * merge adds never reaches it until a full reload, and a full reload destroys
 * every live Browser pane guest.
 *
 * Called from the re-evaluated store module with the preserved instance and
 * the NEW initializer. It runs the initializer against the preserved store's
 * own `set`, `get` and `api`, so the fresh actions close over the live store,
 * and merges one patch into it:
 *
 *   - a function the live store lacks, or whose source text changed, is taken.
 *     An unchanged action keeps its identity, so an effect that lists it in its
 *     deps (the Browser pane's register effect, for one) does not re-run on
 *     every save of the store;
 *   - a state key the live store lacks is taken with its initial value;
 *   - everything else, all live data included, is left alone.
 *
 * The known gap: an edit to a helper alone, at module level or local to the
 * initializer, leaves the actions that call it as they were, since their own
 * text did not change.
 *
 * The initializer must be safe to call again: no I/O, timers or subscriptions,
 * and no state of its own that its old and new actions would then split. The
 * stores that cannot meet that are listed with a reason in
 * tests/unit/hmr-resync.test.ts.
 */
export function refreshPinnedStore<State extends object>(
  preservedStore: StoreApi<State>,
  initializer: StateCreator<State, [], []>,
): void {
  const freshState = initializer(preservedStore.setState, preservedStore.getState, preservedStore);
  const liveState = preservedStore.getState() as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [key, freshValue] of Object.entries(freshState as Record<string, unknown>)) {
    const hasLiveKey = Object.prototype.hasOwnProperty.call(liveState, key);
    if (!hasLiveKey) {
      patch[key] = freshValue;
      continue;
    }
    const liveValue = liveState[key];
    if (typeof freshValue === 'function' && typeof liveValue === 'function'
      && freshValue.toString() !== liveValue.toString()) {
      patch[key] = freshValue;
    }
  }
  if (Object.keys(patch).length === 0) return;
  preservedStore.setState(patch as Partial<State>);
}

/**
 * A refreshing store's mutable module state, as ONE object every evaluation of
 * the module shares. After a refresh, an action an old evaluation started is
 * still in flight while its replacement runs, so both must read and write the
 * same object. A module-scope `let` would give each evaluation its own copy,
 * and a dispose stash copies a primitive rather than sharing it.
 *
 * The caller passes its own `import.meta.hot?.data`, since every module has its
 * own `import.meta.hot`. Outside Vite (production, vitest) that is undefined and
 * this is a plain object.
 *
 * A field an edit adds to the state is filled in on the object an earlier
 * evaluation left, with its initial value, so the new code never reads
 * undefined. The object itself is kept, since old actions still hold it.
 */
export function sharedModuleState<ModuleState extends object>(
  hotData: Record<string, unknown> | undefined,
  key: string,
  createInitialState: () => ModuleState,
): ModuleState {
  const existing = hotData?.[key];
  if (existing !== undefined && existing !== null && typeof existing === 'object') {
    const existingState = existing as Record<string, unknown>;
    for (const [field, initialValue] of Object.entries(createInitialState())) {
      if (!Object.prototype.hasOwnProperty.call(existingState, field)) existingState[field] = initialValue;
    }
    return existing as ModuleState;
  }
  const initialState = createInitialState();
  if (hotData) hotData[key] = initialState;
  return initialState;
}
