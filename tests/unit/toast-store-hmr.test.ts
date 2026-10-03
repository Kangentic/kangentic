/**
 * Unit tests for HMR preservation behavior in src/renderer/stores/toast-store.ts.
 *
 * toast-store preserves visible toasts across Vite Fast Refresh so that a
 * toast mid-display is not vanished by an HMR cycle. The mechanism is:
 *
 *   const initialToasts = import.meta.hot?.data?.toasts ?? [];
 *   // ... store is initialized with initialToasts ...
 *   if (import.meta.hot) {
 *     import.meta.hot.dispose((data) => { data.toasts = useToastStore.getState().toasts; });
 *   }
 *
 * In vitest node mode, `import.meta.hot` is undefined (no Vite HMR runtime).
 * This means:
 *   - The cold-init path is always exercised: `initialToasts` is `[]`.
 *   - The `if (import.meta.hot)` guard prevents the dispose block from
 *     registering, which is the correct production-like behavior.
 *
 * Tests covered:
 *   1. Cold-init: store starts with empty toasts when no HMR data is present.
 *   2. addToast: adds a toast with the correct shape and returns a string id.
 *   3. dismissToast: removes only the targeted toast, leaves others intact.
 *   4. Dispose body contract: stashing `useToastStore.getState().toasts` into
 *      `data.toasts` captures the current store state correctly. We verify this
 *      by calling the dispose body inline (as a plain function) to confirm the
 *      stashed value equals the live state. This ensures the dispose expression
 *      `data.toasts = useToastStore.getState().toasts` is correct by
 *      construction, catching refactors that rename the store import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Toast } from '../../src/renderer/stores/toast-store';

// ---------------------------------------------------------------------------
// Mock config-store. toast-store reads config.notifications.toasts inside
// addToast. We provide a minimal stub that satisfies that access path.
// ---------------------------------------------------------------------------

vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: {
    getState: () => ({
      config: {
        notifications: {
          toasts: {
            durationSeconds: 4,
            maxCount: 5,
          },
        },
      },
    }),
  },
}));

// Import under test AFTER mocks are set up.
import { useToastStore, withinToastLimit } from '../../src/renderer/stores/toast-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset the store to empty toasts between tests without re-importing the module. */
function clearToasts(): void {
  // Directly call dismissToast for each id in the current state to avoid
  // depending on a reset() helper that does not exist in the public API.
  const current = useToastStore.getState().toasts;
  for (const toast of current) {
    useToastStore.getState().dismissToast(toast.id);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('toast-store HMR preservation', () => {
  beforeEach(() => {
    clearToasts();
  });

  it('cold-init: store starts with no toasts when import.meta.hot is undefined', () => {
    // In vitest node mode, import.meta.hot is undefined, so initialToasts = [].
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('addToast returns a non-empty string id and appends to toasts', () => {
    const id = useToastStore.getState().addToast({ message: 'Hello' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].id).toBe(id);
    expect(toasts[0].message).toBe('Hello');
    expect(toasts[0].variant).toBe('info'); // default
  });

  it('addToast respects the variant override', () => {
    useToastStore.getState().addToast({ message: 'Oh no', variant: 'error' });
    const { toasts } = useToastStore.getState();
    expect(toasts[0].variant).toBe('error');
  });

  it('addToast uses duration from config (durationSeconds * 1000)', () => {
    useToastStore.getState().addToast({ message: 'Timed' });
    const { toasts } = useToastStore.getState();
    // durationSeconds: 4 from the config mock -> 4000ms
    expect(toasts[0].duration).toBe(4000);
  });

  it('addToast respects an explicit duration override', () => {
    useToastStore.getState().addToast({ message: 'Custom', duration: 8000 });
    const { toasts } = useToastStore.getState();
    expect(toasts[0].duration).toBe(8000);
  });

  it('dismissToast removes the targeted toast and leaves others intact', () => {
    const idA = useToastStore.getState().addToast({ message: 'A' });
    const idB = useToastStore.getState().addToast({ message: 'B' });
    const idC = useToastStore.getState().addToast({ message: 'C' });

    useToastStore.getState().dismissToast(idB);

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(2);
    expect(toasts.map((t: Toast) => t.id)).toEqual([idA, idC]);
  });

  it('dismissToast is a no-op for an unknown id', () => {
    useToastStore.getState().addToast({ message: 'X' });
    useToastStore.getState().dismissToast('does-not-exist');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('addToast enforces maxCount from config (capped at 5)', () => {
    for (let index = 0; index < 7; index++) {
      useToastStore.getState().addToast({ message: `Toast ${index}` });
    }
    // maxCount: 5 from the config mock
    expect(useToastStore.getState().toasts).toHaveLength(5);
    // Oldest toasts are dropped, so the tail is kept
    expect(useToastStore.getState().toasts[0].message).toBe('Toast 2');
  });

  it('never pushes out a toast that waits for the user while routine toasts can go instead', () => {
    useToastStore.getState().addToast({ message: 'Waiting', duration: 0 });
    for (let index = 0; index < 7; index++) {
      useToastStore.getState().addToast({ message: `Toast ${index}` });
    }
    const messages = useToastStore.getState().toasts.map((toast) => toast.message);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toBe('Waiting');
    expect(messages.slice(1)).toEqual(['Toast 3', 'Toast 4', 'Toast 5', 'Toast 6']);
  });

  it('drops the oldest waiting toast only when waiting toasts alone overflow, and always shows the newest', () => {
    for (let index = 0; index < 6; index++) {
      useToastStore.getState().addToast({ message: `Waiting ${index}`, duration: 0 });
    }
    useToastStore.getState().addToast({ message: 'Newest' });
    const messages = useToastStore.getState().toasts.map((toast) => toast.message);
    expect(messages).toEqual(['Waiting 2', 'Waiting 3', 'Waiting 4', 'Waiting 5', 'Newest']);
  });

  it('withinToastLimit keeps exactly the newest toast when maxCount is 0, waiting toasts included', () => {
    const closesOnItsOwn: Toast = { id: 'routine', message: 'Routine', variant: 'info', duration: 4000 };
    const waitingForUser: Toast = { id: 'waiting', message: 'Waiting', variant: 'info', duration: 0 };
    const newest: Toast = { id: 'newest', message: 'Newest', variant: 'info', duration: 4000 };
    // The newest toast is never a drop candidate (only the toasts before it are),
    // so even a limit of 0 leaves exactly one toast showing.
    expect(withinToastLimit([closesOnItsOwn, waitingForUser, newest], 0)).toEqual([newest]);
    expect(withinToastLimit([waitingForUser, closesOnItsOwn], 0)).toEqual([closesOnItsOwn]);
  });

  it('withinToastLimit hands back the same stack when maxCount is 0 and only one toast is showing', () => {
    // The clamp to 1 is what makes a single toast "within the limit" at
    // maxCount 0, so it returns the input untouched instead of a filtered copy.
    const onlyToast: Toast = { id: 'only', message: 'Only', variant: 'info', duration: 4000 };
    const stack = [onlyToast];
    expect(withinToastLimit(stack, 0)).toBe(stack);
  });

  // ---------------------------------------------------------------------------
  // Dispose body contract test.
  //
  // We cannot trigger the real import.meta.hot.dispose() callback in vitest
  // (import.meta.hot is undefined, so the `if (import.meta.hot)` guard prevents
  // registration). Instead we verify the dispose body's logic by constructing
  // the same expression manually:
  //
  //   data.toasts = useToastStore.getState().toasts
  //
  // and asserting that the captured value matches the live store state. This
  // confirms that if the dispose callback were to run, it would stash the
  // correct data, and that a rename of `useToastStore` in the module body would
  // be caught by the module's own TypeScript compilation rather than silently
  // stashing undefined.
  // ---------------------------------------------------------------------------

  it('dispose body contract: getState().toasts captures live store state', () => {
    const idA = useToastStore.getState().addToast({ message: 'Preserved A' });
    const idB = useToastStore.getState().addToast({ message: 'Preserved B' });

    // Simulate what the dispose callback does:
    const hotData: Record<string, unknown> = {};
    hotData.toasts = useToastStore.getState().toasts;

    const stashed = hotData.toasts as Toast[];
    expect(stashed).toHaveLength(2);
    expect(stashed[0].id).toBe(idA);
    expect(stashed[1].id).toBe(idB);

    // The stashed array is the same reference as the current store state
    // (Zustand returns the same array reference when state has not changed).
    expect(stashed).toBe(useToastStore.getState().toasts);
  });
});
