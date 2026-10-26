/**
 * When the user last pressed a key in any terminal, so work that can wait (building
 * a terminal for a session that just spawned) waits for a pause in the typing
 * instead of landing between two keys.
 *
 * A key's echo paints on the renderer's main thread, and any long task there holds
 * it: building a terminal is a 21 to 42 ms frame in production and 75 to 130 ms in
 * dev (`terminal-init-queue.ts`). `useTerminal` stamps every keydown in a terminal's
 * textarea here except a bare modifier, so an IME composition and a non-ASCII key
 * count the same as a letter.
 *
 * A pointer press anywhere ends the typing: the user has moved on, and a terminal
 * their click asked for must not wait out a hold meant for keys they are no longer
 * pressing. A Ctrl, Alt or Meta combination in a terminal ends it the same way, since it
 * is a shortcut (the Command Terminal's opens a terminal), not text. AltGr, which some
 * layouts need for characters such as `@`, still counts as typing.
 */

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

// hmr-safe: a timestamp. A Fast Refresh reset only ends a hold early.
let lastKeyAt = Number.NEGATIVE_INFINITY;
// hmr-safe: the listener it tracks is removed by the dispose below.
let pointerListenerInstalled = false;

function endTyping(): void {
  lastKeyAt = Number.NEGATIVE_INFINITY;
}

/** The parts of a keydown the stamp reads. A `KeyboardEvent` is one. */
export interface TerminalKeydown {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  getModifierState?: (modifier: string) => boolean;
}

/** Record a key pressed in a terminal. A bare modifier is not typing, and a shortcut
 *  ends the typing. */
export function noteTerminalKeydown(event: TerminalKeydown, now: number = performance.now()): void {
  if (MODIFIER_KEYS.has(event.key)) return;
  const isShortcut = (event.ctrlKey || event.altKey || event.metaKey) && !event.getModifierState?.('AltGraph');
  if (isShortcut) {
    endTyping();
    return;
  }
  lastKeyAt = now;
  if (!pointerListenerInstalled && typeof window !== 'undefined') {
    window.addEventListener('pointerdown', endTyping, { capture: true, passive: true });
    pointerListenerInstalled = true;
  }
}

/** Milliseconds since the last key; infinite before the first and after a pointer press. */
export function msSinceTerminalKeydown(now: number = performance.now()): number {
  return now - lastKeyAt;
}

function removePointerListener(): void {
  if (pointerListenerInstalled && typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', endTyping, { capture: true });
  }
  pointerListenerInstalled = false;
}

/** Forget the last key and the pointer listener. Exists for tests, which share this
 *  module state. */
export function resetTerminalTyping(): void {
  endTyping();
  removePointerListener();
}

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose(() => {
    removePointerListener();
  });
}
