/**
 * The retrieval worker posts a `write-hold` message to main only for a write
 * transaction that held the database lock at least `LONG_WRITE_HOLD_MS`, so a
 * `SQLITE_BUSY` report can name the holder (Sentry DESKTOP-5V). A threshold off
 * by one drops the very hold that explains a 5 s busy wait, or floods main.
 */
import { describe, expect, it } from 'vitest';
import { LONG_WRITE_HOLD_MS, writeHoldMessageFor } from '../../src/main/retrieval/worker/protocol';

describe('writeHoldMessageFor', () => {
  it('posts nothing for a hold under the threshold', () => {
    expect(LONG_WRITE_HOLD_MS).toBe(1000);
    expect(writeHoldMessageFor(999)).toBeNull();
    expect(writeHoldMessageFor(0)).toBeNull();
  });

  it('posts a message for a hold of exactly the threshold', () => {
    expect(writeHoldMessageFor(LONG_WRITE_HOLD_MS)).toEqual({ type: 'write-hold', heldMs: 1000 });
  });

  it('rounds a fractional hold to whole milliseconds', () => {
    expect(writeHoldMessageFor(1234.6)).toEqual({ type: 'write-hold', heldMs: 1235 });
    expect(writeHoldMessageFor(1234.4)).toEqual({ type: 'write-hold', heldMs: 1234 });
  });
});
