/**
 * An agent's exit sequence with pauses (src/main/pty/shutdown/exit-sequence.ts,
 * and the dead-shell writer in src/main/pty/spawn/exited-console-input.ts).
 *
 * A TUI reads Esc followed at once by text as one escape-prefixed key, so a
 * sequence that starts with Esc pauses before the next keys. These pin that
 * the keys before a pause go out at once, the rest only after the pause, that
 * a write that throws neither stops the sequence nor escapes, and that the
 * dead-shell writer reports whether its first keys went out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeExitSteps } from '../../src/main/pty/shutdown/exit-sequence';
import { writeToExitedConsole } from '../../src/main/pty/spawn/exited-console-input';

const ESC_CLEAR_EXIT = ['\x1b', { delayMs: 400 }, '\x03', '/exit\r'];

describe('writeExitSteps', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the keys before a pause at once and the rest after it', () => {
    const written: string[] = [];
    writeExitSteps((data) => written.push(data), ESC_CLEAR_EXIT);
    expect(written).toEqual(['\x1b']);
    vi.advanceTimersByTime(399);
    expect(written).toEqual(['\x1b']);
    vi.advanceTimersByTime(1);
    expect(written).toEqual(['\x1b', '\x03', '/exit\r']);
  });

  it('writes a sequence with no pause in one go, as before', () => {
    const written: string[] = [];
    writeExitSteps((data) => written.push(data), ['\x03', '/exit\r']);
    expect(written).toEqual(['\x03', '/exit\r']);
  });

  it('keeps going after a write throws, and never lets the throw out', () => {
    const written: string[] = [];
    const write = (data: string) => {
      if (data === '\x03') throw new Error('EPIPE');
      written.push(data);
    };
    expect(() => writeExitSteps(write, ESC_CLEAR_EXIT)).not.toThrow();
    expect(() => vi.advanceTimersByTime(400)).not.toThrow();
    expect(written).toEqual(['\x1b', '/exit\r']);
  });
});

describe('writeToExitedConsole with pauses', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ptyWith = (write: (data: string) => boolean) => ({ _agent: { inSocket: { writable: true, destroyed: false, write } } });

  it('writes through the console input, the keys after the pause on a timer', () => {
    const written: string[] = [];
    expect(writeToExitedConsole(ptyWith((data) => { written.push(data); return true; }), ESC_CLEAR_EXIT)).toBe(true);
    expect(written).toEqual(['\x1b']);
    vi.advanceTimersByTime(400);
    expect(written).toEqual(['\x1b', '\x03', '/exit\r']);
  });

  it('reads as not asked when the first keys cannot be written', () => {
    const pty = ptyWith(() => { throw new Error('EPIPE'); });
    expect(writeToExitedConsole(pty, ESC_CLEAR_EXIT)).toBe(false);
  });
});
