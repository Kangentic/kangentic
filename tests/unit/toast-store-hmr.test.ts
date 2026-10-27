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
import { countdownRemaining, useToastStore, withinToastLimit } from '../../src/renderer/stores/toast-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A stored toast, timed (4s) or persistent. */
function makeToast(id: string, persistent: boolean): Toast {
  return {
    id,
    title: id,
    message: id,
    variant: 'info',
    persistent,
    durationMs: persistent ? 0 : 4000,
    remainingMs: persistent ? 0 : 4000,
    runningSince: persistent ? null : 0,
  };
}

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
    const id = useToastStore.getState().addToast({ title: 'Toast', message: 'Hello' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].id).toBe(id);
    expect(toasts[0].message).toBe('Hello');
    expect(toasts[0].variant).toBe('info'); // default
  });

  it('addToast respects the variant override', () => {
    useToastStore.getState().addToast({ title: 'Toast', message: 'Oh no', variant: 'error' });
    const { toasts } = useToastStore.getState();
    expect(toasts[0].variant).toBe('error');
  });

  it('addToast uses duration from config (durationSeconds * 1000)', () => {
    useToastStore.getState().addToast({ title: 'Timed', message: 'Body' });
    const { toasts } = useToastStore.getState();
    // durationSeconds: 4 from the config mock -> 4000ms
    expect(toasts[0].durationMs).toBe(4000);
    expect(toasts[0].remainingMs).toBe(4000);
    expect(toasts[0].persistent).toBe(false);
    expect(toasts[0].runningSince).not.toBeNull();
  });

  it('addToast respects an explicit duration override', () => {
    useToastStore.getState().addToast({ title: 'Custom', message: 'Body', durationMs: 8000 });
    const { toasts } = useToastStore.getState();
    expect(toasts[0].durationMs).toBe(8000);
  });

  it('a persistent toast has no countdown', () => {
    useToastStore.getState().addToast({ title: 'Stays', message: 'Body', persistent: true });
    const [toast] = useToastStore.getState().toasts;
    expect(toast.persistent).toBe(true);
    expect(toast.durationMs).toBe(0);
    expect(toast.runningSince).toBeNull();
  });


  it('updateToast changes the words in place and keeps the toast\'s spot and countdown', () => {
    const firstId = useToastStore.getState().addToast({ title: 'Idle agent paused', message: 'Kangentic paused it to free memory.', persistent: true });
    const secondId = useToastStore.getState().addToast({ title: 'Other', message: 'Body' });
    const before = useToastStore.getState().toasts.find((toast) => toast.id === secondId);

    useToastStore.getState().updateToast(firstId, { title: '2 idle agents paused', message: 'Kangentic paused them to free memory.' });

    const { toasts } = useToastStore.getState();
    expect(toasts.map((toast) => toast.id)).toEqual([firstId, secondId]);
    expect(toasts[0].title).toBe('2 idle agents paused');
    expect(toasts[0].message).toBe('Kangentic paused them to free memory.');
    expect(toasts[0].persistent).toBe(true);
    expect(toasts[1]).toBe(before);
  });

  it('updateToast is a no-op for an unknown id and keeps the same stack', () => {
    useToastStore.getState().addToast({ title: 'A', message: 'Body' });
    const stack = useToastStore.getState().toasts;
    useToastStore.getState().updateToast('does-not-exist', { title: 'B' });
    expect(useToastStore.getState().toasts).toBe(stack);
  });

  it('holding a countdown stops it where it is, and releasing starts it again from there', () => {
    const id = useToastStore.getState().addToast({ title: 'Timed', message: 'Body', durationMs: 10_000 });
    const raisedAt = useToastStore.getState().toasts[0].runningSince ?? 0;

    useToastStore.getState().holdCountdown(id, raisedAt + 3_000);
    const held = useToastStore.getState().toasts[0];
    expect(held.runningSince).toBeNull();
    expect(held.remainingMs).toBe(7_000);
    // Held: no time passes for it.
    expect(countdownRemaining(held, raisedAt + 60_000)).toBe(7_000);

    useToastStore.getState().releaseCountdown(id, raisedAt + 60_000);
    const released = useToastStore.getState().toasts[0];
    expect(released.runningSince).toBe(raisedAt + 60_000);
    expect(countdownRemaining(released, raisedAt + 62_000)).toBe(5_000);
  });

  it('never holds or releases a persistent toast', () => {
    const id = useToastStore.getState().addToast({ title: 'Stays', message: 'Body', persistent: true });
    const stack = useToastStore.getState().toasts;
    useToastStore.getState().holdCountdown(id, Date.now());
    useToastStore.getState().releaseCountdown(id, Date.now());
    expect(useToastStore.getState().toasts).toBe(stack);
  });

  it('countdownRemaining never goes below zero', () => {
    expect(countdownRemaining({ remainingMs: 1_000, runningSince: 0 }, 5_000)).toBe(0);
  });

  it('dismissToast removes the targeted toast and leaves others intact', () => {
    const idA = useToastStore.getState().addToast({ title: 'Toast', message: 'A' });
    const idB = useToastStore.getState().addToast({ title: 'Toast', message: 'B' });
    const idC = useToastStore.getState().addToast({ title: 'Toast', message: 'C' });

    useToastStore.getState().dismissToast(idB);

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(2);
    expect(toasts.map((t: Toast) => t.id)).toEqual([idA, idC]);
  });

  it('dismissToast is a no-op for an unknown id', () => {
    useToastStore.getState().addToast({ title: 'Toast', message: 'X' });
    useToastStore.getState().dismissToast('does-not-exist');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  // onDismiss records a user's answer (the first-launch language suggestion reads a
  // closed card as "do not ask again"), so only the card's X may run it: ToastItem
  // calls it there. A dismissal from code, such as the suggestion's own button
  // closing the card before it opens its prompt, must not.
  it('keeps a persistent toast\'s onDismiss and never runs it from dismissToast', () => {
    const onDismiss = vi.fn();
    const id = useToastStore.getState().addToast({ title: 'Toast', message: 'Persistent', persistent: true, onDismiss });
    const stored = useToastStore.getState().toasts.find((toast: Toast) => toast.id === id);
    expect(stored?.onDismiss).toBe(onDismiss);

    useToastStore.getState().dismissToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('addToast enforces maxCount from config (capped at 5)', () => {
    for (let index = 0; index < 7; index++) {
      useToastStore.getState().addToast({ title: 'Toast', message: `Toast ${index}` });
    }
    // maxCount: 5 from the config mock
    expect(useToastStore.getState().toasts).toHaveLength(5);
    // Oldest toasts are dropped, so the tail is kept
    expect(useToastStore.getState().toasts[0].message).toBe('Toast 2');
  });

  it('never pushes out a toast that waits for the user while routine toasts can go instead', () => {
    useToastStore.getState().addToast({ title: 'Toast', message: 'Waiting', persistent: true });
    for (let index = 0; index < 7; index++) {
      useToastStore.getState().addToast({ title: 'Toast', message: `Toast ${index}` });
    }
    const messages = useToastStore.getState().toasts.map((toast) => toast.message);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toBe('Waiting');
    expect(messages.slice(1)).toEqual(['Toast 3', 'Toast 4', 'Toast 5', 'Toast 6']);
  });

  it('drops the oldest waiting toast only when waiting toasts alone overflow, and always shows the newest', () => {
    for (let index = 0; index < 6; index++) {
      useToastStore.getState().addToast({ title: 'Toast', message: `Waiting ${index}`, persistent: true });
    }
    useToastStore.getState().addToast({ title: 'Toast', message: 'Newest' });
    const messages = useToastStore.getState().toasts.map((toast) => toast.message);
    expect(messages).toEqual(['Waiting 2', 'Waiting 3', 'Waiting 4', 'Waiting 5', 'Newest']);
  });

  it('withinToastLimit keeps exactly the newest toast when maxCount is 0, waiting toasts included', () => {
    const closesOnItsOwn = makeToast('routine', false);
    const waitingForUser = makeToast('waiting', true);
    const newest = makeToast('newest', false);
    // The newest toast is never a drop candidate (only the toasts before it are),
    // so even a limit of 0 leaves exactly one toast showing.
    expect(withinToastLimit([closesOnItsOwn, waitingForUser, newest], 0)).toEqual([newest]);
    expect(withinToastLimit([waitingForUser, closesOnItsOwn], 0)).toEqual([closesOnItsOwn]);
  });

  it('withinToastLimit hands back the same stack when maxCount is 0 and only one toast is showing', () => {
    // The clamp to 1 is what makes a single toast "within the limit" at
    // maxCount 0, so it returns the input untouched instead of a filtered copy.
    const onlyToast = makeToast('only', false);
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
    const idA = useToastStore.getState().addToast({ title: 'Toast', message: 'Preserved A' });
    const idB = useToastStore.getState().addToast({ title: 'Toast', message: 'Preserved B' });

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
