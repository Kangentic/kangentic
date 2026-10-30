import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Which modal overlays are open, and in what order: a dialog (`BaseDialog`),
 * the settings panel, the search palette. Two readers:
 *
 * - The toast stack stops taking clicks while any is open. Toasts sit above
 *   dialogs in the bottom right, exactly where a centred dialog's footer is,
 *   and a card that took clicks there once swallowed the Board Manager's Save.
 * - A key that belongs to one overlay (BaseDialog's save key) acts only for the
 *   topmost. Listeners on one target run in registration order, so without the
 *   order the dialog underneath would see the key first.
 *
 * Registration, not a DOM query: an overlay opened by keyboard while the
 * pointer rests over a toast must close the gate before the next click, and a
 * check made only when the pointer moves would miss it.
 *
 * Kept across a Fast Refresh (Pattern A): an overlay registers on mount, so a
 * re-evaluated module with a fresh map would read "nothing open" under a
 * dialog that is still up.
 */

// Each open overlay's token, mapped to the sequence number it opened with. The
// highest number is on top.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const overlayStack: Map<symbol, number> = import.meta.hot?.data?.overlayStack ?? new Map<symbol, number>();
// @ts-expect-error -- Vite handles import.meta.hot
const listeners: Set<() => void> = import.meta.hot?.data?.overlayGateListeners ?? new Set<() => void>();
// @ts-expect-error -- Vite handles import.meta.hot
const overlaySequence: { next: number } = import.meta.hot?.data?.overlaySequence ?? { next: 0 };

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A sequence number later than every one handed out before it. */
function takeOverlaySequence(): number {
  overlaySequence.next += 1;
  return overlaySequence.next;
}

function unregisterOverlay(token: symbol): void {
  if (!overlayStack.delete(token)) return;
  notify();
}

/** Whether any modal overlay is open, read live (for a keybinding's `when`). */
export function isAnyOverlayOpen(): boolean {
  return overlayStack.size > 0;
}

/** One overlay's place in the stack. */
export interface OverlayEntry {
  /** Count the overlay as open, at the sequence number it holds. */
  open(): void;
  /** Count it as closed. It keeps its number for the next `open`. */
  close(): void;
  /** Count it as closed and drop its number, so the next `open` goes on top. */
  deactivate(): void;
  /** Whether it is open and above every other open overlay. */
  isTop(): boolean;
}

/**
 * An overlay's token and sequence number. The first number is taken here, at
 * creation, which the hook does in render. Render runs parent before child and
 * effects run child first, so a dialog a settings tab opened stays above the
 * panel when a Fast Refresh remounts both in one commit.
 *
 * `close()` then `open()` keeps the number. A Fast Refresh re-runs an edited
 * component's effects, and a fresh number would lift a dialog that is
 * underneath above the one the user is looking at. Only a real reopen
 * (`deactivate()`, then `open()`) takes a new number.
 */
export function createOverlayEntry(): OverlayEntry {
  const token = Symbol('overlay');
  let sequence: number | null = takeOverlaySequence();
  return {
    open() {
      if (sequence === null) sequence = takeOverlaySequence();
      overlayStack.set(token, sequence);
      notify();
    },
    close() {
      unregisterOverlay(token);
    },
    deactivate() {
      unregisterOverlay(token);
      sequence = null;
    },
    isTop() {
      const ownSequence = overlayStack.get(token);
      if (ownSequence === undefined) return false;
      for (const otherSequence of overlayStack.values()) {
        if (otherSequence > ownSequence) return false;
      }
      return true;
    },
  };
}

/**
 * Counts the calling overlay as open for as long as it is mounted (and
 * `active`), and returns a live "is this overlay on top" check.
 */
export function useRegisterOpenOverlay(active = true): () => boolean {
  const [entry] = useState(createOverlayEntry);
  useEffect(() => {
    if (!active) {
      entry.deactivate();
      return;
    }
    entry.open();
    return () => entry.close();
  }, [active, entry]);
  return entry.isTop;
}

/** Whether any modal overlay is open, kept current as they open and close. */
export function useAnyOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, isAnyOverlayOpen, isAnyOverlayOpen);
}

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.overlayStack = overlayStack;
    data.overlayGateListeners = listeners;
    data.overlaySequence = overlaySequence;
  });
}
