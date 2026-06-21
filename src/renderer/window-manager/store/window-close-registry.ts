/**
 * A tiny imperative registry mapping a window id to its guarded close function
 * (`closeWithGuard` from `TaskDetailWindow`). It lets a central, store-driven
 * dismiss (the click-outside hook in `useClickOutsideToClose`) route a close
 * back through the per-window unsaved-edits guard, which lives in component-local
 * state the window store cannot see.
 *
 * The map is module scope so the hook can dispatch without subscribing to it (a
 * close fn in reactive store state would re-render on every register). It is a
 * `const` mutated in place; every `TaskDetailWindow` re-runs its register effect
 * on (re)mount, so an HMR reload that re-evaluates this module with an empty map
 * self-heals as the windows remount.
 */
// hmr-safe: re-populated by each TaskDetailWindow's register effect on remount
const windowClosers = new Map<string, () => void>();

export function registerWindowCloser(windowId: string, closeWithGuard: () => void): void {
  windowClosers.set(windowId, closeWithGuard);
}

export function unregisterWindowCloser(windowId: string): void {
  windowClosers.delete(windowId);
}

/** Invoke a window's registered guarded close, if one is registered. */
export function requestWindowClose(windowId: string): void {
  windowClosers.get(windowId)?.();
}
