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
 * is a shortcut (the Command Terminal's opens a terminal), not text. Two still count
 * as typing: AltGr, which some layouts need for characters such as `@`, and Alt with
 * one printable character, which is how macOS's Option types them.
 */

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

interface TypingState {
  lastKeyAt: number;
  /** The capture-phase pointerdown listener, while one is installed. */
  pointerListener: (() => void) | null;
}

// Preserved across HMR (Pattern A) as one object. A terminal mounted before a Fast
// Refresh keeps the old module's `noteTerminalKeydown` on its textarea, so the old
// and the new module must stamp the clock the refreshed queue reads, and share the
// one pointer listener the dispose below removes.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const typingState: TypingState = import.meta.hot?.data?.typingState ?? {
  lastKeyAt: Number.NEGATIVE_INFINITY,
  pointerListener: null,
};

function endTyping(): void {
  typingState.lastKeyAt = Number.NEGATIVE_INFINITY;
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
  const altTypesCharacter = event.altKey && !event.ctrlKey && !event.metaKey && [...event.key].length === 1;
  const isShortcut = (event.ctrlKey || event.altKey || event.metaKey) && !event.getModifierState?.('AltGraph') && !altTypesCharacter;
  if (isShortcut) {
    endTyping();
    return;
  }
  typingState.lastKeyAt = now;
  if (typingState.pointerListener === null && typeof window !== 'undefined') {
    const listener = (): void => endTyping();
    window.addEventListener('pointerdown', listener, { capture: true, passive: true });
    typingState.pointerListener = listener;
  }
}

/** Milliseconds since the last key; infinite before the first and after a pointer press. */
export function msSinceTerminalKeydown(now: number = performance.now()): number {
  return now - typingState.lastKeyAt;
}

function removePointerListener(): void {
  if (typingState.pointerListener !== null && typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', typingState.pointerListener, { capture: true });
  }
  typingState.pointerListener = null;
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
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    // The listener goes with the old module; the next key, through whichever
    // module stamps it, installs the one that replaces it.
    removePointerListener();
    data.typingState = typingState;
  });
}
