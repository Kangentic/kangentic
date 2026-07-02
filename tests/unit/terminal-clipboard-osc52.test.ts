import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  decodeOsc52Payload,
  stripOsc52Sequences,
  enableTerminalClipboard,
  copySelectionToClipboard,
} from '../../src/renderer/utils/terminal-clipboard';

/**
 * Unit coverage for the OSC 52 clipboard path added so Claude Code's TUI
 * copy-on-select (and any TUI emitting ESC]52) actually reaches the OS clipboard
 * in the embedded terminal. Covers the two pure helpers plus the write-only
 * handler registration and its read-request rejection.
 */

/** Base64-encode a UTF-8 string the way a TUI would build an OSC 52 payload. */
function toBase64Utf8(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('decodeOsc52Payload', () => {
  it('decodes an ASCII write payload', () => {
    expect(decodeOsc52Payload(`c;${toBase64Utf8('hello')}`)).toBe('hello');
  });

  it('round-trips multibyte UTF-8', () => {
    const original = 'héllo ✓ 漢字';
    expect(decodeOsc52Payload(`c;${toBase64Utf8(original)}`)).toBe(original);
  });

  it('returns null for a read request (Pd === "?")', () => {
    expect(decodeOsc52Payload('c;?')).toBeNull();
  });

  it('returns null when there is no separator', () => {
    expect(decodeOsc52Payload('cnoseparator')).toBeNull();
  });

  it('returns null for an empty payload', () => {
    expect(decodeOsc52Payload('c;')).toBeNull();
  });

  it('returns null for malformed base64', () => {
    // A '*' is outside the base64 alphabet, so atob throws.
    expect(decodeOsc52Payload('c;****')).toBeNull();
  });

  it('returns null for an oversized payload', () => {
    const huge = 'A'.repeat(1024 * 1024 + 4); // exceeds the ~1MB base64 cap
    expect(decodeOsc52Payload(`c;${huge}`)).toBeNull();
  });

  it('decodes regardless of the Pc selection field', () => {
    const payload = toBase64Utf8('sel');
    for (const pc of ['', 'c', 'p', 's', 'cp0']) {
      expect(decodeOsc52Payload(`${pc};${payload}`)).toBe('sel');
    }
  });
});

describe('stripOsc52Sequences', () => {
  it('removes a BEL-terminated sequence', () => {
    const input = `before\x1b]52;c;${toBase64Utf8('x')}\x07after`;
    expect(stripOsc52Sequences(input)).toBe('beforeafter');
  });

  it('removes an ST-terminated (ESC\\) sequence', () => {
    const input = `a\x1b]52;c;${toBase64Utf8('x')}\x1b\\b`;
    expect(stripOsc52Sequences(input)).toBe('ab');
  });

  it('removes a C1 ST (\\x9c) terminated sequence', () => {
    const input = `a\x1b]52;c;${toBase64Utf8('x')}\x9cb`;
    expect(stripOsc52Sequences(input)).toBe('ab');
  });

  it('removes multiple occurrences', () => {
    const one = `\x1b]52;c;${toBase64Utf8('1')}\x07`;
    const two = `\x1b]52;c;${toBase64Utf8('2')}\x07`;
    expect(stripOsc52Sequences(`x${one}y${two}z`)).toBe('xyz');
  });

  it('preserves surrounding text byte-for-byte', () => {
    const input = `line1\r\nline2 ${'\x1b]52;c;' + toBase64Utf8('copied') + '\x07'} tail`;
    expect(stripOsc52Sequences(input)).toBe('line1\r\nline2  tail');
  });

  it('leaves other OSC and CSI sequences untouched', () => {
    const title = '\x1b]0;my title\x07';
    const hyperlink = '\x1b]8;;https://example.com\x07link\x1b]8;;\x07';
    const csi = '\x1b[1;31mred\x1b[0m';
    const input = `${title}${hyperlink}${csi}`;
    expect(stripOsc52Sequences(input)).toBe(input);
  });

  it('returns ESC-free input unchanged', () => {
    expect(stripOsc52Sequences('plain scrollback text')).toBe('plain scrollback text');
  });

  // -------------------------------------------------------------------------
  // Bare-ESC termination: xterm's EscapeSequenceParser dispatches (ends) an OSC
  // string on a bare ESC that introduces the next escape sequence, not only on
  // BEL/ST/C1-ST. A recorded OSC 52 write immediately followed by another
  // escape sequence (no BEL/ST in between) must still be stripped, and the
  // following sequence must be left completely intact.
  // -------------------------------------------------------------------------

  it('strips an OSC 52 sequence terminated by a bare ESC that introduces a CSI sequence, leaving the CSI intact', () => {
    const input = `x\x1b]52;c;${toBase64Utf8('copied')}\x1b[0my`;
    expect(stripOsc52Sequences(input)).toBe('x\x1b[0my');
  });

  it('strips an OSC 52 sequence terminated by a bare ESC that introduces another OSC sequence, leaving it intact', () => {
    const input = `x\x1b]52;c;${toBase64Utf8('copied')}\x1b]0;title\x07y`;
    expect(stripOsc52Sequences(input)).toBe('x\x1b]0;title\x07y');
  });

  it('strips a BEL-terminated sequence immediately followed by a bare-ESC-terminated sequence, both removed', () => {
    const input = `\x1b]52;c;${toBase64Utf8('one')}\x07\x1b]52;c;${toBase64Utf8('two')}\x1b[0m`;
    expect(stripOsc52Sequences(input)).toBe('\x1b[0m');
  });
});

describe('enableTerminalClipboard OSC 52 handler registration', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  type OscHandler = (data: string) => boolean;

  function setup(): { oscHandler: OscHandler; writeText: ReturnType<typeof vi.fn> } {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error -- minimal window stub for the handler's clipboard call
    globalThis.window = { electronAPI: { clipboard: { writeText } } };

    let oscHandler: OscHandler | null = null;
    const terminal = {
      attachCustomKeyEventHandler: () => undefined,
      parser: {
        registerOscHandler: (code: number, handler: OscHandler) => {
          if (code === 52) oscHandler = handler;
          return { dispose() { /* noop */ } };
        },
      },
      hasSelection: () => false,
      getSelection: () => '',
      cols: 80,
    } as unknown as Terminal;
    const el = {
      querySelector: () => null,
      addEventListener: () => undefined,
      matches: () => false,
    } as unknown as HTMLElement;

    enableTerminalClipboard(terminal, el);
    if (!oscHandler) throw new Error('OSC 52 handler was not registered');
    return { oscHandler, writeText };
  }

  it('writes decoded text to the clipboard on a valid OSC 52 write and consumes the sequence', () => {
    const { oscHandler, writeText } = setup();
    expect(oscHandler(`c;${toBase64Utf8('copied-text')}`)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('copied-text');
  });

  it('ignores a read request but still consumes the sequence', () => {
    const { oscHandler, writeText } = setup();
    expect(oscHandler('c;?')).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('copySelectionToClipboard', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  function stubWindowClipboard(): ReturnType<typeof vi.fn> {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error -- minimal window stub for the write call
    globalThis.window = { electronAPI: { clipboard: { writeText } } };
    return writeText;
  }

  function makeTerminalStub(selection: string, cols = 80): Terminal {
    return { getSelection: () => selection, cols } as unknown as Terminal;
  }

  it('writes the cleaned selection via window.electronAPI.clipboard.writeText (focus-independent main-process write)', () => {
    const writeText = stubWindowClipboard();

    copySelectionToClipboard(makeTerminalStub('selected text  '));

    expect(writeText).toHaveBeenCalledWith('selected text');
  });

  it('is a no-op when there is no selection', () => {
    const writeText = stubWindowClipboard();

    copySelectionToClipboard(makeTerminalStub(''));

    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('copy routing via the Ctrl+C / Ctrl+Shift+C key handler', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  type KeyEventHandler = (event: KeyboardEvent) => boolean;

  /**
   * Captures the key handler attachCustomKeyEventHandler is given, from a
   * terminal stub that reports an active selection - mirrors the handler-capture
   * pattern in terminal-escape-release.test.ts, extended with a real
   * getSelection() so the copy branch has text to clean and write.
   */
  function setupKeyHandler(): { handler: KeyEventHandler; writeText: ReturnType<typeof vi.fn> } {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error -- minimal window stub for the handler's clipboard call
    globalThis.window = { electronAPI: { clipboard: { writeText } } };

    let handler: KeyEventHandler | null = null;
    const terminal = {
      attachCustomKeyEventHandler: (keyEventHandler: KeyEventHandler) => { handler = keyEventHandler; },
      parser: { registerOscHandler: () => ({ dispose() { /* noop */ } }) },
      hasSelection: () => true,
      getSelection: () => 'some selected text',
      cols: 80,
    } as unknown as Terminal;
    const el = {
      querySelector: () => null,
      addEventListener: () => undefined,
      matches: () => false,
    } as unknown as HTMLElement;

    enableTerminalClipboard(terminal, el);
    if (!handler) throw new Error('key handler was not registered');
    return { handler, writeText };
  }

  function keydown(overrides: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: '',
      ...overrides,
    } as unknown as KeyboardEvent;
  }

  it('routes Ctrl+C (with an active selection) to window.electronAPI.clipboard.writeText and suppresses the default key behavior', () => {
    const { handler, writeText } = setupKeyHandler();

    const handled = handler(keydown({ ctrlKey: true, key: 'c' }));

    expect(handled).toBe(false);
    expect(writeText).toHaveBeenCalledWith('some selected text');
  });

  it('routes Ctrl+Shift+C to window.electronAPI.clipboard.writeText and suppresses the default key behavior', () => {
    const { handler, writeText } = setupKeyHandler();

    const handled = handler(keydown({ ctrlKey: true, shiftKey: true, key: 'C' }));

    expect(handled).toBe(false);
    expect(writeText).toHaveBeenCalledWith('some selected text');
  });
});
