import { describe, it, expect, vi } from 'vitest';

// handler-helpers imports `commandHandlers` from ../commands, which transitively
// loads better-sqlite3 (a native module). makeTaskCounter is a pure function with
// no such dependency, so stub the commands barrel to keep this a pure unit test
// that exercises the REAL counter (the broader mcp-task-session-tools suite mocks
// the whole handler-helpers module and so cannot cover makeTaskCounter itself).
vi.mock('../../src/main/agent/commands', () => ({ commandHandlers: {} }));

import { makeTaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';

// The runaway-loop ceiling is a fixed internal constant (MAX_TASK_CREATE_PER_LAUNCH
// in handler-helpers.ts), not a user-tunable setting. limit() reports it.
describe('makeTaskCounter (fixed runaway-loop ceiling)', () => {
  it('reports a high fixed ceiling via limit()', () => {
    const counter = makeTaskCounter();
    expect(counter.limit()).toBeGreaterThanOrEqual(500);
  });

  it('reserves up to the ceiling, then refuses', () => {
    const counter = makeTaskCounter();
    const ceiling = counter.limit();

    for (let reserved = 0; reserved < ceiling; reserved++) {
      expect(counter.tryReserve()).toBe(true);
    }
    // The ceiling is reached: the next reservation is refused.
    expect(counter.tryReserve()).toBe(false);
    // And stays refused (the count does not roll over).
    expect(counter.tryReserve()).toBe(false);
  });

  it('each counter accumulates independently of others', () => {
    const first = makeTaskCounter();
    const second = makeTaskCounter();
    expect(first.tryReserve()).toBe(true);
    // A reservation on one counter does not advance the other.
    expect(second.tryReserve()).toBe(true);
  });
});
