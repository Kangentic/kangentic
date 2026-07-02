import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { enableTerminalClipboard } from '../../src/renderer/utils/terminal-clipboard';

/**
 * Unit coverage for the embedded-terminal Escape policy used by the task detail
 * dialog (`releaseEscapeWhenPointerOutside`). The decision is deterministic and
 * easy to assert here; the end-to-end wiring (xterm focus, :hover, propagation)
 * is exercised manually. See enableTerminalClipboard.
 */

type KeyEventHandler = (event: KeyboardEvent) => boolean;

function captureKeyHandler(options: { hover: boolean; release?: boolean }): {
  handler: KeyEventHandler;
} {
  let handler: KeyEventHandler | null = null;
  const terminal = {
    attachCustomKeyEventHandler: (keyEventHandler: KeyEventHandler) => { handler = keyEventHandler; },
    parser: { registerOscHandler: () => ({ dispose() { /* noop */ } }) },
    hasSelection: () => false,
    getSelection: () => '',
    cols: 80,
  } as unknown as Terminal;

  // Minimal element stub: no xterm child nodes, controllable :hover state.
  const el = {
    querySelector: () => null,
    addEventListener: () => undefined,
    matches: (selector: string) => (selector === ':hover' ? options.hover : false),
  } as unknown as HTMLElement;

  enableTerminalClipboard(terminal, el, undefined, undefined, undefined, options.release);
  if (!handler) throw new Error('key handler was not registered');
  return { handler };
}

function escapeKeydown(): { event: KeyboardEvent; stopPropagation: ReturnType<typeof vi.fn> } {
  const stopPropagation = vi.fn();
  const event = { type: 'keydown', key: 'Escape', stopPropagation } as unknown as KeyboardEvent;
  return { event, stopPropagation };
}

describe('terminal Escape release (task detail dialog)', () => {
  it('declines Escape (returns false) when the pointer is outside the terminal so it bubbles to close the dialog', () => {
    const { handler } = captureKeyHandler({ hover: false, release: true });
    const { event, stopPropagation } = escapeKeydown();
    expect(handler(event)).toBe(false);
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it('keeps Escape (returns true) and stops propagation when the pointer is over the terminal', () => {
    const { handler } = captureKeyHandler({ hover: true, release: true });
    const { event, stopPropagation } = escapeKeydown();
    expect(handler(event)).toBe(true);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to the terminal unchanged when the release flag is off (other terminals)', () => {
    const { handler } = captureKeyHandler({ hover: false, release: false });
    const { event, stopPropagation } = escapeKeydown();
    // Without the flag, Escape is a normal key for the terminal (return true)
    // and propagation is untouched.
    expect(handler(event)).toBe(true);
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});
