import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranscriptWriter } from '../../src/main/pty/buffer/transcript-writer';

// --- TranscriptWriter class ---

describe('TranscriptWriter', () => {
  const sink = { appendChunk: vi.fn() };

  let writer: TranscriptWriter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Every session belongs to one project whose database is open.
    writer = new TranscriptWriter(() => 'project-1', () => sink);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('onData accumulates stripped text in pending buffer', () => {
    writer.onData('session-1', '\x1b[31mhello\x1b[0m');
    writer.onData('session-1', ' \x1b[32mworld\x1b[0m');

    // Nothing flushed yet (debounced)
    expect(sink.appendChunk).not.toHaveBeenCalled();

    // Finalize forces flush
    writer.finalize('session-1');
    expect(sink.appendChunk).toHaveBeenCalledOnce();
    expect(sink.appendChunk).toHaveBeenCalledWith('session-1', 'hello world');
  });

  it('writes each flush as its own piece, with no row to create first', () => {
    writer.onData('session-1', 'a');
    writer.finalize('session-1');

    writer.onData('session-1', 'b');
    writer.finalize('session-1');

    expect(sink.appendChunk.mock.calls).toEqual([['session-1', 'a'], ['session-1', 'b']]);
  });

  it('flushes automatically after 30 seconds', () => {
    writer.onData('session-1', 'hello');

    expect(sink.appendChunk).not.toHaveBeenCalled();

    // Advance past the 30s debounce
    vi.advanceTimersByTime(30_000);

    expect(sink.appendChunk).toHaveBeenCalledOnce();
    expect(sink.appendChunk).toHaveBeenCalledWith('session-1', 'hello');
  });

  it('debounces multiple onData calls into a single flush', () => {
    writer.onData('session-1', 'a');
    writer.onData('session-1', 'b');
    writer.onData('session-1', 'c');

    vi.advanceTimersByTime(30_000);

    expect(sink.appendChunk).toHaveBeenCalledOnce();
    expect(sink.appendChunk).toHaveBeenCalledWith('session-1', 'abc');
  });

  it('handles multiple sessions independently', () => {
    writer.onData('session-1', 'hello');
    writer.onData('session-2', 'world');

    writer.finalize('session-1');
    writer.finalize('session-2');

    expect(sink.appendChunk).toHaveBeenCalledTimes(2);
    expect(sink.appendChunk).toHaveBeenCalledWith('session-1', 'hello');
    expect(sink.appendChunk).toHaveBeenCalledWith('session-2', 'world');
  });

  it('finalize clears the pending buffer', () => {
    writer.onData('session-1', 'data');
    writer.finalize('session-1');

    // Second finalize should be a no-op (buffer is empty)
    writer.finalize('session-1');
    expect(sink.appendChunk).toHaveBeenCalledOnce();
  });

  it('remove flushes the remainder and forgets the session', () => {
    writer.onData('session-1', 'data');
    writer.remove('session-1');

    expect(sink.appendChunk).toHaveBeenCalledOnce();

    // A later session under the same id starts clean.
    writer.onData('session-1', 'more');
    writer.finalize('session-1');
    expect(sink.appendChunk).toHaveBeenCalledTimes(2);
    expect(sink.appendChunk).toHaveBeenLastCalledWith('session-1', 'more');
  });

  it('skips empty data after ANSI stripping', () => {
    // Pure escape sequences with no visible text
    writer.onData('session-1', '\x1b[31m\x1b[0m');

    writer.finalize('session-1');
    // No flush should happen (nothing to write)
    expect(sink.appendChunk).not.toHaveBeenCalled();
  });

  it('swallows DB errors without crashing', () => {
    sink.appendChunk.mockImplementationOnce(() => {
      throw new Error('DB write failed');
    });

    writer.onData('session-1', 'data');

    // Should not throw
    expect(() => writer.finalize('session-1')).not.toThrow();
  });

  it('finalizeAll flushes all pending sessions', () => {
    writer.onData('session-1', 'a');
    writer.onData('session-2', 'b');

    writer.finalizeAll();

    expect(sink.appendChunk).toHaveBeenCalledTimes(2);
  });
});
