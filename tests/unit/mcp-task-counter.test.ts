import { describe, it, expect, vi } from 'vitest';

// handler-helpers imports `commandHandlers` from ../commands, which transitively
// loads better-sqlite3 (a native module). makeTaskCounter is a pure function with
// no such dependency, so stub the commands barrel to keep this a pure unit test
// that exercises the REAL counter (the broader mcp-task-session-tools suite mocks
// the whole handler-helpers module and so cannot cover makeTaskCounter itself).
vi.mock('../../src/main/agent/commands', () => ({ commandHandlers: {} }));

import { makeTaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';

describe('makeTaskCounter (settings-driven, live ceiling)', () => {
  it('enforces the ceiling and reads it fresh on every reservation', () => {
    let max = 2;
    const counter = makeTaskCounter(() => max);

    expect(counter.tryReserve()).toBe(true);  // 1
    expect(counter.tryReserve()).toBe(true);  // 2
    expect(counter.tryReserve()).toBe(false); // 3 - at ceiling

    // Raising the configured ceiling lets more reservations through WITHOUT
    // resetting the accumulated count: the thunk is read live on each call, so a
    // settings change takes effect mid-launch.
    max = 4;
    expect(counter.tryReserve()).toBe(true);  // 3
    expect(counter.tryReserve()).toBe(true);  // 4
    expect(counter.tryReserve()).toBe(false); // 5 - at the new ceiling
  });

  it('blocks further reservations when the ceiling is lowered below the current count', () => {
    let max = 5;
    const counter = makeTaskCounter(() => max);
    expect(counter.tryReserve()).toBe(true); // 1
    expect(counter.tryReserve()).toBe(true); // 2

    max = 1; // now below the accumulated count of 2
    expect(counter.tryReserve()).toBe(false);
  });

  it('exposes the current ceiling live via limit()', () => {
    let max = 7;
    const counter = makeTaskCounter(() => max);
    expect(counter.limit()).toBe(7);
    max = 9;
    expect(counter.limit()).toBe(9);
  });
});
