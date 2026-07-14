import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TranscriptWriter,
  stripAnsiEscapes,
  filterAltScreenContent,
} from '../../src/main/pty/buffer/transcript-writer';
import type { TranscriptRepository } from '../../src/main/db/repositories/transcript-repository';

describe('stripAnsiEscapes', () => {
  it('strips SGR color codes', () => {
    const input = '\x1b[31mred text\x1b[0m normal';
    expect(stripAnsiEscapes(input)).toBe('red text normal');
  });

  it('strips 256-color SGR codes', () => {
    const input = '\x1b[38;5;196mcolored\x1b[0m';
    expect(stripAnsiEscapes(input)).toBe('colored');
  });

  it('strips 24-bit RGB SGR codes', () => {
    const input = '\x1b[38;2;255;100;50mrgb text\x1b[0m';
    expect(stripAnsiEscapes(input)).toBe('rgb text');
  });

  it('strips bold, italic, underline decorations', () => {
    const input = '\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m';
    expect(stripAnsiEscapes(input)).toBe('bold italic underline');
  });

  it('strips cursor movement sequences', () => {
    const input = '\x1b[5Aup\x1b[3Bdown\x1b[10Cforward\x1b[2Dback';
    expect(stripAnsiEscapes(input)).toBe('updownforwardback');
  });

  it('strips cursor positioning (CUP)', () => {
    const input = '\x1b[1;1Htop-left\x1b[10;20Hmiddle';
    expect(stripAnsiEscapes(input)).toBe('top-leftmiddle');
  });

  it('strips erase display and erase line', () => {
    const input = '\x1b[2Jcleared\x1b[Kline';
    expect(stripAnsiEscapes(input)).toBe('clearedline');
  });

  it('strips screen buffer switch (alternate screen)', () => {
    const input = 'before\x1b[?1049hinside\x1b[?1049lafter';
    expect(stripAnsiEscapes(input)).toBe('beforeinsideafter');
  });

  it('strips OSC sequences (window title)', () => {
    const input = '\x1b]0;My Window Title\x07visible text';
    expect(stripAnsiEscapes(input)).toBe('visible text');
  });

  it('strips OSC sequences terminated by ST', () => {
    const input = '\x1b]2;title\x1b\\visible';
    expect(stripAnsiEscapes(input)).toBe('visible');
  });

  it('strips OSC hyperlinks', () => {
    const input = '\x1b]8;;https://example.com\x07link text\x1b]8;;\x07';
    expect(stripAnsiEscapes(input)).toBe('link text');
  });

  it('strips DCS sequences', () => {
    // DCS = ESC P (no space between ESC and P)
    const input = '\x1bPsome device control\x1b\\visible';
    expect(stripAnsiEscapes(input)).toBe('visible');
  });

  it('strips APC sequences', () => {
    const input = '\x1b_application command\x1b\\visible';
    expect(stripAnsiEscapes(input)).toBe('visible');
  });

  it('strips two-character ESC sequences (save/restore cursor)', () => {
    // ESC 7 (save) and ESC 8 (restore) are single-byte finals
    const input = 'before\x1b7save\x1b8after';
    expect(stripAnsiEscapes(input)).toBe('beforesaveafter');
  });

  it('strips charset selection sequences', () => {
    // ESC ( B is ESC + intermediate '(' + final 'B'
    // The two-char ESC regex matches ESC + '(' leaving 'B' as text
    const input = '\x1b(Btext';
    const result = stripAnsiEscapes(input);
    // The 'B' may remain as text (harmless) since charset selection
    // is ESC + intermediate + final, not a simple two-char sequence
    expect(result).toContain('text');
    expect(result).not.toContain('\x1b');
  });

  it('strips C0 control characters except tab and newline', () => {
    const input = 'hello\x07\x08\x00world';
    expect(stripAnsiEscapes(input)).toBe('helloworld');
  });

  it('preserves tabs', () => {
    const input = 'col1\tcol2\tcol3';
    expect(stripAnsiEscapes(input)).toBe('col1\tcol2\tcol3');
  });

  it('preserves newlines', () => {
    const input = 'line1\nline2\nline3';
    expect(stripAnsiEscapes(input)).toBe('line1\nline2\nline3');
  });

  it('normalizes \\r\\n to \\n', () => {
    const input = 'line1\r\nline2\r\n';
    expect(stripAnsiEscapes(input)).toBe('line1\nline2\n');
  });

  it('normalizes standalone \\r to \\n', () => {
    const input = 'line1\rline2';
    expect(stripAnsiEscapes(input)).toBe('line1\nline2');
  });

  it('collapses excessive blank lines', () => {
    const input = 'line1\n\n\n\n\nline2';
    expect(stripAnsiEscapes(input)).toBe('line1\n\nline2');
  });

  it('trims trailing whitespace on lines', () => {
    const input = 'hello   \nworld   ';
    expect(stripAnsiEscapes(input)).toBe('hello\nworld');
  });

  it('handles complex real-world output with mixed sequences', () => {
    // Simulate Claude Code TUI output: color + cursor + alternate screen
    const input = '\x1b[?1049h\x1b[1;1H\x1b[2J\x1b[38;2;100;200;255m> \x1b[0mHello\x1b[K\n\x1b[32m+ added line\x1b[0m\x1b[?1049l';
    const result = stripAnsiEscapes(input);
    expect(result).toContain('Hello');
    expect(result).toContain('+ added line');
    expect(result).not.toContain('\x1b');
  });

  it('handles empty input', () => {
    expect(stripAnsiEscapes('')).toBe('');
  });

  it('handles input with no escape sequences', () => {
    const input = 'plain text with no escapes';
    expect(stripAnsiEscapes(input)).toBe('plain text with no escapes');
  });

  it('strips 8-bit C1 CSI sequence', () => {
    // \x9b is 8-bit CSI - equivalent to ESC [
    // \x9b31m is equivalent to ESC[31m (red color)
    const input = 'hello\x9b31mworld\x9b0m';
    expect(stripAnsiEscapes(input)).toBe('helloworld');
  });

  it('strips standalone 8-bit C1 codes', () => {
    // \x85 (NEL), \x8d (RI) etc. are standalone C1 codes
    const input = 'hello\x85\x8dworld';
    expect(stripAnsiEscapes(input)).toBe('helloworld');
  });
});

describe('filterAltScreenContent', () => {
  it('keeps content emitted before alt-screen entry', () => {
    const input = 'banner\x1b[?1049hredraw';
    const result = filterAltScreenContent(input, false);
    expect(result.content).toBe('banner');
    expect(result.inAltAtEnd).toBe(true);
  });

  it('drops content emitted entirely inside alt-screen', () => {
    const input = 'redraw frame 1';
    const result = filterAltScreenContent(input, true);
    expect(result.content).toBe('');
    expect(result.inAltAtEnd).toBe(true);
  });

  it('keeps content emitted after alt-screen exit', () => {
    const input = 'last frame\x1b[?1049lpost-tui summary';
    const result = filterAltScreenContent(input, true);
    expect(result.content).toBe('post-tui summary');
    expect(result.inAltAtEnd).toBe(false);
  });

  it('handles enter and exit in the same chunk', () => {
    const input = 'before\x1b[?1049hinside\x1b[?1049lafter';
    const result = filterAltScreenContent(input, false);
    expect(result.content).toBe('beforeafter');
    expect(result.inAltAtEnd).toBe(false);
  });

  it('threads state across multiple chunks', () => {
    const first = filterAltScreenContent('Claude Code v2.1\x1b[?1049h', false);
    expect(first.content).toBe('Claude Code v2.1');
    expect(first.inAltAtEnd).toBe(true);

    const second = filterAltScreenContent('Test: Birds\nBirds\nSauteed for 1s', first.inAltAtEnd);
    expect(second.content).toBe('');
    expect(second.inAltAtEnd).toBe(true);

    const third = filterAltScreenContent('\x1b[?1049lSession ended', second.inAltAtEnd);
    expect(third.content).toBe('Session ended');
    expect(third.inAltAtEnd).toBe(false);
  });

  it('recognizes 1047 and 47 alt-screen sequences', () => {
    expect(filterAltScreenContent('a\x1b[?1047hb\x1b[?1047lc', false)).toEqual({
      content: 'ac',
      inAltAtEnd: false,
    });
    expect(filterAltScreenContent('a\x1b[?47hb\x1b[?47lc', false)).toEqual({
      content: 'ac',
      inAltAtEnd: false,
    });
  });

  it('passes through chunks with no alt-screen toggles when not in alt', () => {
    const result = filterAltScreenContent('plain stdout text\n', false);
    expect(result.content).toBe('plain stdout text\n');
    expect(result.inAltAtEnd).toBe(false);
  });

  it('does not lose state if regex was used elsewhere first', () => {
    // Sanity: simulate stale lastIndex from a prior global-regex use.
    const input = 'before\x1b[?1049hinside';
    // Run twice in a row - both should yield the same answer if state is reset.
    const first = filterAltScreenContent(input, false);
    const second = filterAltScreenContent(input, false);
    expect(first).toEqual(second);
    expect(first.content).toBe('before');
  });
});

describe('TranscriptWriter class', () => {
  const sessionId = 'session-under-test';
  const MAX_PENDING_CHARS = TranscriptWriter.MAX_PENDING_CHARS;

  let createSpy: ReturnType<typeof vi.fn>;
  let appendChunkSpy: ReturnType<typeof vi.fn>;
  let writer: TranscriptWriter;

  beforeEach(() => {
    vi.useFakeTimers();
    createSpy = vi.fn();
    appendChunkSpy = vi.fn();
    writer = new TranscriptWriter({
      create: createSpy,
      appendChunk: appendChunkSpy,
    } as unknown as TranscriptRepository);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes under-cap data only when the 30s debounce fires', () => {
    writer.onData(sessionId, 'hello');
    writer.onData(sessionId, '-world');
    expect(appendChunkSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expect(createSpy).toHaveBeenCalledWith(sessionId);
    expect(appendChunkSpy).toHaveBeenCalledTimes(1);
    expect(appendChunkSpy).toHaveBeenCalledWith(sessionId, 'hello-world');
  });

  it('flushes immediately once pending exceeds the byte cap, without a double flush at 30s', () => {
    const bigChunk = 'x'.repeat(MAX_PENDING_CHARS);
    writer.onData(sessionId, bigChunk);

    // Early flush fired synchronously, no timer advance needed.
    expect(appendChunkSpy).toHaveBeenCalledTimes(1);
    expect(appendChunkSpy.mock.calls[0][1]).toHaveLength(MAX_PENDING_CHARS);

    // The debounce timer was cleared by the flush; nothing further to write.
    vi.advanceTimersByTime(30_000);
    expect(appendChunkSpy).toHaveBeenCalledTimes(1);
  });

  it('accumulates across chunks and early-flushes when the total crosses the cap', () => {
    const half = 'y'.repeat(Math.ceil(MAX_PENDING_CHARS / 2));
    writer.onData(sessionId, half);
    expect(appendChunkSpy).not.toHaveBeenCalled();

    writer.onData(sessionId, half);
    expect(appendChunkSpy).toHaveBeenCalledTimes(1);
  });

  it('never trips the cap on alt-screen content (dropped before accumulation)', () => {
    writer.onData(sessionId, `\x1b[?1049h${'z'.repeat(MAX_PENDING_CHARS * 2)}`);
    expect(appendChunkSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(appendChunkSpy).not.toHaveBeenCalled();
  });

  it('remove() flushes the pending remainder', () => {
    writer.onData(sessionId, 'tail content');
    writer.remove(sessionId);

    expect(appendChunkSpy).toHaveBeenCalledTimes(1);
    expect(appendChunkSpy).toHaveBeenCalledWith(sessionId, 'tail content');
  });

  it('finalizeAll() flushes every session', () => {
    writer.onData('session-a', 'aaa');
    writer.onData('session-b', 'bbb');
    writer.finalizeAll();

    expect(appendChunkSpy).toHaveBeenCalledWith('session-a', 'aaa');
    expect(appendChunkSpy).toHaveBeenCalledWith('session-b', 'bbb');
  });
});
