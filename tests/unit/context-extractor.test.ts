import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranscriptWriter, stripAnsiEscapes } from '../../src/main/pty/buffer/transcript-writer';

// --- TranscriptWriter class ---

describe('TranscriptWriter', () => {
  const mockRepo = {
    create: vi.fn(),
    appendChunk: vi.fn(),
    getBySessionId: vi.fn(),
    getTranscriptText: vi.fn(),
    getSizeBytes: vi.fn(),
  };

  let writer: TranscriptWriter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    writer = new TranscriptWriter(mockRepo as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('onData accumulates stripped text in pending buffer', () => {
    writer.onData('session-1', '\x1b[31mhello\x1b[0m');
    writer.onData('session-1', ' \x1b[32mworld\x1b[0m');

    // Nothing flushed yet (debounced)
    expect(mockRepo.appendChunk).not.toHaveBeenCalled();

    // Finalize forces flush
    writer.finalize('session-1');
    expect(mockRepo.appendChunk).toHaveBeenCalledOnce();
    expect(mockRepo.appendChunk).toHaveBeenCalledWith('session-1', 'hello world');
  });

  it('lazily creates transcript row on first flush', () => {
    writer.onData('session-1', 'hello');

    // No DB calls yet (debounced)
    expect(mockRepo.create).not.toHaveBeenCalled();

    // First flush creates the row then appends
    writer.finalize('session-1');
    expect(mockRepo.create).toHaveBeenCalledOnce();
    expect(mockRepo.create).toHaveBeenCalledWith('session-1');
    expect(mockRepo.appendChunk).toHaveBeenCalledOnce();
  });

  it('does not re-create row on subsequent flushes', () => {
    writer.onData('session-1', 'a');
    writer.finalize('session-1');

    writer.onData('session-1', 'b');
    writer.finalize('session-1');

    // create called only once, appendChunk called twice
    expect(mockRepo.create).toHaveBeenCalledOnce();
    expect(mockRepo.appendChunk).toHaveBeenCalledTimes(2);
  });

  it('flushes automatically after 30 seconds', () => {
    writer.onData('session-1', 'hello');

    expect(mockRepo.appendChunk).not.toHaveBeenCalled();

    // Advance past the 30s debounce
    vi.advanceTimersByTime(30_000);

    expect(mockRepo.appendChunk).toHaveBeenCalledOnce();
    expect(mockRepo.appendChunk).toHaveBeenCalledWith('session-1', 'hello');
  });

  it('debounces multiple onData calls into a single flush', () => {
    writer.onData('session-1', 'a');
    writer.onData('session-1', 'b');
    writer.onData('session-1', 'c');

    vi.advanceTimersByTime(30_000);

    expect(mockRepo.appendChunk).toHaveBeenCalledOnce();
    expect(mockRepo.appendChunk).toHaveBeenCalledWith('session-1', 'abc');
  });

  it('handles multiple sessions independently', () => {
    writer.onData('session-1', 'hello');
    writer.onData('session-2', 'world');

    writer.finalize('session-1');
    writer.finalize('session-2');

    expect(mockRepo.appendChunk).toHaveBeenCalledTimes(2);
    expect(mockRepo.appendChunk).toHaveBeenCalledWith('session-1', 'hello');
    expect(mockRepo.appendChunk).toHaveBeenCalledWith('session-2', 'world');
  });

  it('finalize clears the pending buffer', () => {
    writer.onData('session-1', 'data');
    writer.finalize('session-1');

    // Second finalize should be a no-op (buffer is empty)
    writer.finalize('session-1');
    expect(mockRepo.appendChunk).toHaveBeenCalledOnce();
  });

  it('remove flushes and cleans up initialized state', () => {
    writer.onData('session-1', 'data');
    writer.remove('session-1');

    expect(mockRepo.appendChunk).toHaveBeenCalledOnce();

    // After remove, next flush re-creates the row (initialized state cleared)
    writer.onData('session-1', 'more');
    writer.finalize('session-1');
    expect(mockRepo.create).toHaveBeenCalledTimes(2);
    expect(mockRepo.appendChunk).toHaveBeenCalledTimes(2);
  });

  it('skips empty data after ANSI stripping', () => {
    // Pure escape sequences with no visible text
    writer.onData('session-1', '\x1b[31m\x1b[0m');

    writer.finalize('session-1');
    // No flush should happen (nothing to write)
    expect(mockRepo.create).not.toHaveBeenCalled();
    expect(mockRepo.appendChunk).not.toHaveBeenCalled();
  });

  it('swallows DB errors without crashing', () => {
    mockRepo.create.mockImplementationOnce(() => {
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

    expect(mockRepo.appendChunk).toHaveBeenCalledTimes(2);
  });
});
