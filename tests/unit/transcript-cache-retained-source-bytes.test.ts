/**
 * `retainedSourceBytes(fileSize)` in `transcript-cache.ts`: the source bytes a
 * cached record's entries can have been parsed from, which is what the cache's
 * byte budget counts. A parse reads at most two parse windows of a file however
 * large it is, so the charge is `min(fileSize, 2 * parseWindowBytes())`. Charging
 * the whole file let one 548 MB transcript take the entire budget and evict every
 * other session; charging a window or less than the file would under-count.
 *
 * The parse window is shrunk with `setParseWindowBytesForTests` so the bound is
 * small and exact, and restored after each test so no other file sees it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { retainedSourceBytes } from '../../src/main/agent/transcript-cache';
import { parseWindowBytes, setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

const WINDOW_BYTES = 1000;

afterEach(() => {
  setParseWindowBytesForTests();
});

describe('retainedSourceBytes', () => {
  it('caps a file far larger than the window at two windows', () => {
    setParseWindowBytesForTests(WINDOW_BYTES);

    expect(retainedSourceBytes(10 * WINDOW_BYTES)).toBe(2 * WINDOW_BYTES);
  });

  it('charges a file smaller than one window its own size', () => {
    setParseWindowBytesForTests(WINDOW_BYTES);

    expect(retainedSourceBytes(WINDOW_BYTES / 2)).toBe(WINDOW_BYTES / 2);
  });

  it('charges a file between one and two windows its own size, not one window', () => {
    setParseWindowBytesForTests(WINDOW_BYTES);

    expect(retainedSourceBytes(1.5 * WINDOW_BYTES)).toBe(1.5 * WINDOW_BYTES);
  });

  it('switches from the file\'s size to the cap exactly at two windows', () => {
    setParseWindowBytesForTests(WINDOW_BYTES);

    expect(retainedSourceBytes(2 * WINDOW_BYTES - 1)).toBe(2 * WINDOW_BYTES - 1);
    expect(retainedSourceBytes(2 * WINDOW_BYTES)).toBe(2 * WINDOW_BYTES);
    expect(retainedSourceBytes(2 * WINDOW_BYTES + 1)).toBe(2 * WINDOW_BYTES);
  });

  it('charges an empty file nothing', () => {
    setParseWindowBytesForTests(WINDOW_BYTES);

    expect(retainedSourceBytes(0)).toBe(0);
  });

  it('follows the parse window when it changes', () => {
    setParseWindowBytesForTests(WINDOW_BYTES);
    const underSmallWindow = retainedSourceBytes(10 * WINDOW_BYTES);

    setParseWindowBytesForTests(3 * WINDOW_BYTES);
    const underLargeWindow = retainedSourceBytes(10 * WINDOW_BYTES);

    expect(underSmallWindow).toBe(2 * WINDOW_BYTES);
    expect(underLargeWindow).toBe(6 * WINDOW_BYTES);
  });

  it('is capped at two of the default windows once the test override is cleared', () => {
    setParseWindowBytesForTests(WINDOW_BYTES);
    setParseWindowBytesForTests();
    const defaultWindowBytes = parseWindowBytes();

    expect(defaultWindowBytes).toBeGreaterThan(WINDOW_BYTES);
    expect(retainedSourceBytes(Number.MAX_SAFE_INTEGER)).toBe(2 * defaultWindowBytes);
  });
});
