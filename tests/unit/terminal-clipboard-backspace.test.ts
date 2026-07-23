import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { enableTerminalClipboard } from '../../src/renderer/utils/terminal-clipboard';

/**
 * Unit coverage for the "Backspace sends Ctrl+H" terminal setting: plain
 * Backspace remaps from xterm's default DEL (0x7f) to Ctrl+H (0x08) when
 * enabled, matching native Windows conhost so Claude Code's TUI deletes the
 * previous word instead of one character. Ctrl/Alt/Meta+Backspace are left
 * untouched (they already produce the desired byte sequences today).
 */

type KeyEventHandler = (event: KeyboardEvent) => boolean;

function captureKeyHandler(getBackspaceSendsCtrlH?: () => boolean): {
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

  enableTerminalClipboard(
    terminal,
    el,
    onWrite,
    undefined,
    undefined,
    undefined,
    undefined,
    getBackspaceSendsCtrlH,
  );
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

describe('terminal Backspace-sends-Ctrl+H setting', () => {
  it('sends Ctrl+H (0x08) and suppresses the default key when the setting is enabled', () => {
    const { handler, onWrite } = captureKeyHandler(() => true);

    const handled = handler(backspaceKeydown());

    expect(handled).toBe(false);
    expect(onWrite).toHaveBeenCalledWith('\x08');
  });

  it('leaves Backspace to xterm default (DEL) when the setting is disabled', () => {
    const { handler, onWrite } = captureKeyHandler(() => false);

    const handled = handler(backspaceKeydown());

    expect(handled).toBe(true);
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('leaves Backspace to xterm default when no getter is supplied (backward-compatible default off)', () => {
    const { handler, onWrite } = captureKeyHandler(undefined);

    const handled = handler(backspaceKeydown());

    expect(handled).toBe(true);
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('does not remap Ctrl+Backspace even when the setting is enabled (already sends 0x08 natively)', () => {
    const { handler, onWrite } = captureKeyHandler(() => true);

    const handled = handler(backspaceKeydown({ ctrlKey: true }));

    expect(handled).toBe(true);
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('does not remap Alt+Backspace even when the setting is enabled (already sends ESC 0x7f)', () => {
    const { handler, onWrite } = captureKeyHandler(() => true);

    const handled = handler(backspaceKeydown({ altKey: true }));

    expect(handled).toBe(true);
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('does not remap Meta+Backspace even when the setting is enabled', () => {
    const { handler, onWrite } = captureKeyHandler(() => true);

    const handled = handler(backspaceKeydown({ metaKey: true }));

    expect(handled).toBe(true);
    expect(onWrite).not.toHaveBeenCalled();
  });
});
