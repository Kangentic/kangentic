import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { enableTerminalClipboard } from '../../src/renderer/utils/terminal-clipboard';

/**
 * The terminal's custom key handler leaves Backspace alone in every modifier
 * combination, so xterm's own encoding reaches the PTY: DEL (0x7f) for plain
 * Backspace and Ctrl+H (0x08) for Ctrl+Backspace, which Claude Code's TUI reads
 * as delete-previous-word. A handler that wrote its own byte here would re-map
 * one of those keys. tests/ui/terminal-backspace-bytes.spec.ts pins the bytes
 * xterm then sends.
 */

type KeyEventHandler = (event: KeyboardEvent) => boolean;

function captureKeyHandler(): {
  handler: KeyEventHandler;
  onWrite: ReturnType<typeof vi.fn>;
} {
  let handler: KeyEventHandler | null = null;
  const terminal = {
    attachCustomKeyEventHandler: (keyEventHandler: KeyEventHandler) => { handler = keyEventHandler; },
    parser: { registerOscHandler: () => ({ dispose() { /* noop */ } }) },
    hasSelection: () => false,
    getSelection: () => '',
    cols: 80,
  } as unknown as Terminal;

  const el = {
    querySelector: () => null,
    addEventListener: () => undefined,
    matches: () => false,
  } as unknown as HTMLElement;

  const onWrite = vi.fn();

  enableTerminalClipboard(terminal, el, onWrite);
  if (!handler) throw new Error('key handler was not registered');
  return { handler, onWrite };
}

function backspaceKeydown(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'Backspace',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe('terminal Backspace passthrough', () => {
  it.each([
    ['plain Backspace', {}],
    ['Ctrl+Backspace', { ctrlKey: true }],
    ['Alt+Backspace', { altKey: true }],
    ['Meta+Backspace', { metaKey: true }],
  ])('leaves %s to xterm and writes nothing itself', (_name, modifiers) => {
    const { handler, onWrite } = captureKeyHandler();

    const handled = handler(backspaceKeydown(modifiers));

    expect(handled).toBe(true);
    expect(onWrite).not.toHaveBeenCalled();
  });
});
