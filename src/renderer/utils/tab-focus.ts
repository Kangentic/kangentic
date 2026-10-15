/**
 * Whether the focus move happening right now came from Tab or Shift+Tab.
 *
 * A HoverTip opens on focus only for this move: the user stepping to the next control. Chromium's
 * `:focus-visible` is not the same test. It also matches a script's focus after ANY key, so a
 * confirm dialog that a key opened, which moves focus to its close button on mount, popped that
 * button's tip, and the next Escape closed the tip instead of the dialog. Arrowing through a menu,
 * a listbox or a radio group matches it as well, and in those widgets Escape belongs to the widget,
 * so a tip on every option would take the key each time.
 *
 * The flag is set by a capture-phase keydown on `window`, which runs before the key's default
 * action moves focus, and cleared one task later, so it covers the focus that Tab moves and the
 * one a focus trap moves for it while handling the same key, and nothing after.
 */

// hmr-safe: one flag that lives for a single task; a Fast Refresh at worst drops one Tab's tip.
let tabKeyDownPending = false;
// hmr-safe: whether the listeners are on; the dispose below takes them off and clears it.
let installed = false;

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Tab') {
    tabKeyDownPending = false;
    return;
  }
  tabKeyDownPending = true;
  window.setTimeout(() => {
    tabKeyDownPending = false;
  }, 0);
}

function handlePointerDown(): void {
  tabKeyDownPending = false;
}

/** Start watching for Tab. Idempotent; the first HoverTip to mount calls it. */
export function installTabFocusTracker(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('pointerdown', handlePointerDown, true);
}

/** True while handling the focus that a Tab or Shift+Tab press moved. */
export function focusCameFromTab(): boolean {
  return tabKeyDownPending;
}

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose(() => {
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('pointerdown', handlePointerDown, true);
    installed = false;
    tabKeyDownPending = false;
  });
}
